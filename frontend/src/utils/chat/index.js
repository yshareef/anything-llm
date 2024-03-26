export const ABORT_STREAM_EVENT = "abort-chat-stream";
import Swal from 'sweetalert2';

// For handling of chat responses in the frontend by their various types.
export default  function handleChat(
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
    const userResponse = await promptUserForSensitiveData(redactedMessage);

    if (userResponse.abort) {
      handleChat({
        uuid,
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: "User aborted due to sensitive data.",
      });
    } else {
      // Call streamChat again with the redacted message
      streamChat({ slug }, redactedMessage, handleChat);
    }
  }

}

// Implement the promptUserForSensitiveData function
const promptUserForSensitiveData = async (redactedMessage) => {
  const { isConfirmed } = await Swal.fire({
    title: 'Sensitive Data Detected',
    html: `Your message contains sensitive data:<br><br>${redactedMessage}`,
    showCancelButton: true,
    confirmButtonText: 'Proceed',
    cancelButtonText: 'Abort',
  });

  return { abort: !isConfirmed };
};

export function chatPrompt(workspace) {
  return (
    workspace?.openAiPrompt ??
    "Given the following conversation, relevant context, and a follow up question, reply with an answer to the current question the user is asking. Return only your response to the question given the above information following the users instructions as needed."
  );
}
