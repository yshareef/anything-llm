// Import a logging library like Winston
const winston = require('winston');

const EventEmitter = require('events');

const { v4: uuidv4 } = require("uuid");
const { DocumentManager } = require("../DocumentManager");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { getVectorDbClass, getLLMProvider } = require("../helpers");
const { writeResponseChunk } = require("../helpers/chat/responses");
const {
  grepCommand,
  VALID_COMMANDS,
  chatPrompt,
  recentChatHistory,
} = require("./index");

const VALID_CHAT_MODE = ["chat", "query"];

const { checkForSensitiveData } = require('../helpers/sensitiveDataHandler');

//implement waitForUserChoice function
const userChoiceEmitter = new EventEmitter();

// async function waitForUserChoice(response, uuid) {
//   return new Promise((resolve, reject) => {
//     const timeout = setTimeout(() => {
//       reject(new Error('Timed out waiting for user choice'));
//       userChoiceEmitter.removeAllListeners(`userChoice:${uuid}`);
//     }, 30000); // Set a reasonable timeout, e.g., 30 seconds

//     const handleUserChoice = (userChoice) => {
//       clearTimeout(timeout);
//       userChoiceEmitter.removeAllListeners(`userChoice:${uuid}`);
//       resolve(userChoice);
//     };

//     userChoiceEmitter.on(`userChoice:${uuid}`, handleUserChoice);
//   });
// }
// // Middleware or route handler to receive the user's choice from the frontend
// app.post('/api/user-choice', (req, res) => {
//   const { userChoice, uuid } = req.body;

//   // Emit the user's choice event
//   userChoiceEmitter.emit(`userChoice:${uuid}`, userChoice);

//   res.status(200).json({ message: 'User choice received' });
// });

// function handleUserChoiceRoute(req, res) {
//   const { userChoice, uuid } = req.body;

//   // Emit the user's choice event
//   userChoiceEmitter.emit(`userChoice:${uuid}`, userChoice);

//   res.status(200).json({ message: 'User choice received' });
// }


async function streamChatWithWorkspace(
  response,
  workspace,
  message,
  chatMode = "chat",
  user = null,
  thread = null
) {
  const uuid = uuidv4();
  const command = grepCommand(message);

  if (!!command && Object.keys(VALID_COMMANDS).includes(command)) {
    const data = await VALID_COMMANDS[command](
      workspace,
      message,
      uuid,
      user,
      thread
    );
    writeResponseChunk(response, data);
    return;
  }

  const LLMConnector = getLLMProvider(workspace?.chatModel);
  const VectorDb = getVectorDbClass();
  const { safe, reasons = [] } = await LLMConnector.isSafe(message);
  if (!safe) {
    writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: `This message was moderated and will not be allowed. Violations for ${reasons.join(
        ", "
      )} found.`,
    });
    return;
  }

// check for sensitive data
  const { containsSensitiveData, redactedMessage } = checkForSensitiveData(message);

  if (containsSensitiveData) {
    writeResponseChunk(response, {
      id: uuid,
      type: "sensitiveDataDetected",
      close: false,
      error: null,
      redactedMessage,
    });

    // Wait for a POST request from the frontend with the user's choice
    const userChoice = await waitForUserChoice(response, uuid);

    if (userChoice === 'abort') {
      writeResponseChunk(response, {
        id: uuid,
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: `This message was moderated and will not be allowed. Violations for sensitve data found.`,
      });
      return;
    }
    else{
      message = redactedMessage ; 
      console.log(message);
    };
  }



  const messageLimit = workspace?.openAiHistory || 20;
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

  // User is trying to query-mode chat a workspace that has no data in it - so
  // we should exit early as no information can be found under these conditions.
  if ((!hasVectorizedSpace || embeddingsCount === 0) && chatMode === "query") {
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse:
        "There is no relevant information in this workspace to answer your query.",
      sources: [],
      close: true,
      error: null,
    });
    return;
  }

  // If we are here we know that we are in a workspace that is:
  // 1. Chatting in "chat" mode and may or may _not_ have embeddings
  // 2. Chatting in "query" mode and has at least 1 embedding
  let completeText;
  let contextTexts = [];
  let sources = [];
  const { rawHistory, chatHistory } = await recentChatHistory({
    user,
    workspace,
    thread,
    messageLimit,
    chatMode,
  });

  // Look for pinned documents and see if the user decided to use this feature. We will also do a vector search
  // as pinning is a supplemental tool but it should be used with caution since it can easily blow up a context window.
  await new DocumentManager({
    workspace,
    maxTokens: LLMConnector.limits.system,
  })
    .pinnedDocs()
    .then((pinnedDocs) => {
      pinnedDocs.forEach((doc) => {
        const { pageContent, ...metadata } = doc;
        contextTexts.push(doc.pageContent);
        sources.push({
          text:
            pageContent.slice(0, 1_000) +
            "...continued on in source document...",
          ...metadata,
        });
      });
    });

  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: message,
          LLMConnector,
          similarityThreshold: workspace?.similarityThreshold,
          topN: workspace?.topN,
        })
      : {
          contextTexts: [],
          sources: [],
          message: null,
        };

  // Failed similarity search if it was run at all and failed.
  if (!!vectorSearchResults.message) {
    writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: vectorSearchResults.message,
    });
    return;
  }

  contextTexts = [...contextTexts, ...vectorSearchResults.contextTexts];
  sources = [...sources, ...vectorSearchResults.sources];

  // If in query mode and no sources are found, do not
  // let the LLM try to hallucinate a response or use general knowledge and exit early
  if (chatMode === "query" && sources.length === 0) {
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse:
        "There is no relevant information in this workspace to answer your query.",
      sources: [],
      close: true,
      error: null,
    });
    return;
  }

  // Compress & Assemble message to ensure prompt passes token limit with room for response
  // and build system messages based on inputs and history.
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt: chatPrompt(workspace),
      userPrompt: message,
      contextTexts,
      chatHistory,
    },
    rawHistory
  );

  // If streaming is not explicitly enabled for connector
  // we do regular waiting of a response and send a single chunk.
  if (LLMConnector.streamingEnabled() !== true) {
    console.log(
      `\x1b[31m[STREAMING DISABLED]\x1b[0m Streaming is not available for ${LLMConnector.constructor.name}. Will use regular chat method.`
    );
    completeText = await LLMConnector.getChatCompletion(messages, {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
    });
    writeResponseChunk(response, {
      uuid,
      sources,
      type: "textResponseChunk",
      textResponse: completeText,
      close: true,
      error: false,
    });
  } else {
    const stream = await LLMConnector.streamGetChatCompletion(messages, {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
    });
    completeText = await LLMConnector.handleStream(response, stream, {
      uuid,
      sources,
    });
  }

  const { chat } = await WorkspaceChats.new({
    workspaceId: workspace.id,
    prompt: message,
    response: { text: completeText, sources, type: chatMode },
    threadId: thread?.id || null,
    user,
  });

  writeResponseChunk(response, {
    uuid,
    type: "finalizeResponseStream",
    close: true,
    error: false,
    chatId: chat.id,
  });
  return;
}

async function waitForUserChoice(response, uuid) {
  // Log start of waiting for user choice
  winston.info(`Waiting for user choice with UUID: ${uuid}`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for user choice'));
      userChoiceEmitter.removeAllListeners(`userChoice:${uuid}`);
      // Log timeout error
      winston.error('Timed out waiting for user choice');
    }, 20000); // Set a reasonable timeout, e.g., 20 seconds

    const handleUserChoice = (userChoice) => {
      clearTimeout(timeout);
      userChoiceEmitter.removeAllListeners(`userChoice:${uuid}`);
      // Log user choice
      winston.info(`User choice received for UUID ${uuid}: ${userChoice}`);

      resolve(userChoice);
    };

    // Error handling for event emitter
    userChoiceEmitter.on(`userChoice:${uuid}`, handleUserChoice);

    // Error handling for event emitter error event
    userChoiceEmitter.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);

    // Log error
    winston.error(`Error occurred while waiting for user choice: ${error.message}`);

  });
});
}

module.exports = {
  userChoiceEmitter,
  handleUserChoiceRoute: (req, res) => {
    const { userChoice, uuid } = req.body;
    // Emit the user's choice event
    userChoiceEmitter.emit(`userChoice:${uuid}`, userChoice);
    console.log(`userChoiceuuid:${uuid}`)
    console.log(`userChoice:${userChoice}`)
    res.status(200).json({ message: 'User choice received 4' });
  },
  VALID_CHAT_MODE,
  streamChatWithWorkspace,
};
