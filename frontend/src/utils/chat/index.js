export const ABORT_STREAM_EVENT = "abort-chat-stream";
import { promptUserForSensitiveData } from './sensitiveDataHandler.js';

// For handling of chat responses in the frontend by their various types.
export default async function handleChat(
  chatResult,
  setLoadingResponse,
  setChatHistory,
  remHistory,
  _chatHistory
) {
  const {
    uuid,
    textResponse,
    type,
    sources = [],
    error,
    close,
    chatId = null,
    redactedMessage
  } = chatResult;

  if (type === "abort") {
    setLoadingResponse(false);
    setChatHistory([
      ...remHistory,
      {
        uuid,
        content: textResponse,
        role: "assistant",
        sources,
        closed: true,
        error,
        animate: false,
        pending: false,
      },
    ]);
    _chatHistory.push({
      uuid,
      content: textResponse,
      role: "assistant",
      sources,
      closed: true,
      error,
      animate: false,
      pending: false,
    });
  } else if (type === "textResponse") {
    setLoadingResponse(false);
    setChatHistory([
      ...remHistory,
      {
        uuid,
        content: textResponse,
        role: "assistant",
        sources,
        closed: close,
        error,
        animate: !close,
        pending: false,
        chatId,
      },
    ]);
    _chatHistory.push({
      uuid,
      content: textResponse,
      role: "assistant",
      sources,
      closed: close,
      error,
      animate: !close,
      pending: false,
      chatId,
    });
  } else if (type === "textResponseChunk") {
    const chatIdx = _chatHistory.findIndex((chat) => chat.uuid === uuid);
    if (chatIdx !== -1) {
      const existingHistory = { ..._chatHistory[chatIdx] };
      const updatedHistory = {
        ...existingHistory,
        content: existingHistory.content + textResponse,
        sources,
        error,
        closed: close,
        animate: !close,
        pending: false,
        chatId,
      };
      _chatHistory[chatIdx] = updatedHistory;
    } else {
      _chatHistory.push({
        uuid,
        sources,
        error,
        content: textResponse,
        role: "assistant",
        closed: close,
        animate: !close,
        pending: false,
        chatId,
      });
    }
    setChatHistory([..._chatHistory]);
  } else if (type === "finalizeResponseStream") {
    const chatIdx = _chatHistory.findIndex((chat) => chat.uuid === uuid);
    if (chatIdx !== -1) {
      const existingHistory = { ..._chatHistory[chatIdx] };
      const updatedHistory = {
        ...existingHistory,
        chatId, // finalize response stream only has some specific keys for data. we are explicitly listing them here.
      };
      _chatHistory[chatIdx] = updatedHistory;
    }
    setChatHistory([..._chatHistory]);
    setLoadingResponse(false);
  } else if (type === "stopGeneration") {
    const chatIdx = _chatHistory.length - 1;
    const existingHistory = { ..._chatHistory[chatIdx] };
    const updatedHistory = {
      ...existingHistory,
      sources: [],
      closed: true,
      error: null,
      animate: false,
      pending: false,
    };
    _chatHistory[chatIdx] = updatedHistory;

    setChatHistory([..._chatHistory]);
    setLoadingResponse(false);
  }
  else if (type === "sensitiveDataDetected") {
    // Prompt the user with a modal or dialog box
    // const userResponse = await promptUserForSensitiveData(redactedMessage);

    setLoadingResponse(false);
    const { abort } = await promptUserForSensitiveData(redactedMessage);
    console.log(abort);
    console.log(chatResult);
    // Send a POST request to the backend with the user's choice
    sendUserChoiceToBackend(abort ? 'abort' : 'continue', chatResult.id);

    
    // if (userResponse.abort) {
    //   handleChat({
    //     uuid: chatResult.uuid,
    //     type: "abort",
    //     textResponse: null,
    //     sources: [],
    //     close: true,
    //     error: "User aborted due to sensitive data.",
    //   });
    //   console.log("abort");

    // } else {
    //     // Call streamChat again with the redacted message
    //   // streamChat({ slug }, redactedMessage, handleChat);
    //   console.log("others ");
    //   // Resend the message with the redacted data
    //   streamChat({ slug: chatResult.workspace.slug }, redactedMessage, handleChat);
    // }
  }

}
 
function sendUserChoiceToBackend(userChoice, uuid) {
  // Send a POST request to the backend with the user's choice
  // For example, using fetch:
  fetch('http://localhost:3001/api/user-choice', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userChoice, uuid }),
  })
    .then(response => {
      // Handle the response from the backend if needed
    })
    .catch(error => {
      console.error('Error sending user choice:', error);
    });
}

export function chatPrompt(workspace) {
  return (
    workspace?.openAiPrompt ??
    "Given the following conversation, relevant context, and a follow up question, reply with an answer to the current question the user is asking. Return only your response to the question given the above information following the users instructions as needed."
  );
}
