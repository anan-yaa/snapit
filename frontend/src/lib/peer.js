const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const CHUNK_SIZE = 16 * 1024; // 16 KB chunks for WebRTC DataChannel
const ACK_TIMEOUT_MS = 10_000;
const RETRY_LIMIT = 5;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const outgoingTransfers = new Map();
const incomingTransfers = new Map();
const pendingAcks = new Map();

const ensureChannelOpen = async (channel) => {
  if (channel.readyState === "open") return channel;

  if (channel.readyState === "closed") {
    throw new Error("Data channel is closed");
  }

  return new Promise((resolve, reject) => {
    const handleOpen = () => {
      cleanup();
      resolve(channel);
    };

    const handleClose = () => {
      cleanup();
      reject(new Error("Data channel closed before opening"));
    };

    const handleError = (event) => {
      cleanup();
      reject(event instanceof Error ? event : new Error("Data channel error"));
    };

    const cleanup = () => {
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
    };

    channel.addEventListener("open", handleOpen, { once: true });
    channel.addEventListener("close", handleClose, { once: true });
    channel.addEventListener("error", handleError, { once: true });
  });
};

// Helper functions for chunking
function chunkKey(transferId, chunkIndex) {
  return `${transferId}:${chunkIndex}`;
}

function encodeChunkFrame(transferId, chunkIndex, arrayBuffer) {
  const idBytes = textEncoder.encode(transferId);
  const payload = new Uint8Array(arrayBuffer);
  const frame = new Uint8Array(10 + idBytes.length + payload.byteLength);
  const view = new DataView(frame.buffer);

  view.setUint16(0, idBytes.length, false);
  view.setUint32(2, chunkIndex, false);
  view.setUint32(6, payload.byteLength, false);

  frame.set(idBytes, 10);
  frame.set(payload, 10 + idBytes.length);

  return frame.buffer;
}

function decodeChunkFrame(buffer) {
  const view = new DataView(buffer);
  const idLength = view.getUint16(0, false);
  const chunkIndex = view.getUint32(2, false);
  const payloadLength = view.getUint32(6, false);

  const idStart = 10;
  const idBytes = new Uint8Array(buffer, idStart, idLength);
  const transferId = textDecoder.decode(idBytes);

  const payloadStart = idStart + idLength;
  const payload = buffer.slice(payloadStart, payloadStart + payloadLength);

  return { transferId, chunkIndex, payload };
}

function waitForAck(transferId, chunkIndex) {
  return new Promise((resolve, reject) => {
    const key = chunkKey(transferId, chunkIndex);

    const timeoutId = setTimeout(() => {
      pendingAcks.delete(key);
      reject(new Error(`Ack timeout for chunk ${chunkIndex}`));
    }, ACK_TIMEOUT_MS);

    pendingAcks.set(key, {
      resolve: (payload) => {
        clearTimeout(timeoutId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    });
  });
}

function resolveAck(message) {
  if (!message) return;
  const key = chunkKey(message.transferId, message.chunkIndex);
  const pending = pendingAcks.get(key);
  if (!pending) return;
  pendingAcks.delete(key);
  pending.resolve(message);
}

function sendAck(channel, transferId, chunkIndex, transfer) {
  if (!channel || channel.readyState !== "open") return;
  try {
    channel.send(
      JSON.stringify({
        type: "chunk-ack",
        transferId,
        chunkIndex,
        receivedBytes: transfer?.receivedBytes ?? null,
        receivedChunks: transfer?.receivedChunks ?? null,
        totalChunks: transfer?.metadata?.totalChunks ?? null,
      })
    );
  } catch (error) {
    console.error("Failed to send ACK", error);
  }
}

function triggerDownload(name, url) {
  const anchor = document.createElement("a");
  anchor.style.display = "none";
  anchor.href = url;
  anchor.download = name || "received-file";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 0);
}

function finalizeIncomingTransfer(transferId, onFileReceived) {
  const transfer = incomingTransfers.get(transferId);
  if (!transfer || transfer.completed) return;
  if (transfer.receivedChunks !== transfer.metadata.totalChunks) return;

  const blob = new Blob(transfer.chunks, {
    type: transfer.metadata.type || "application/octet-stream",
  });

  const url = URL.createObjectURL(blob);

  if (onFileReceived) {
    try {
      onFileReceived({ name: transfer.metadata.name, blob, url });
    } catch (error) {
      console.error("onFileReceived handler failed", error);
    }
  } else {
    triggerDownload(transfer.metadata.name, url);
  }

  transfer.completed = true;
  incomingTransfers.delete(transferId);
}

function handleIncomingChunk(channel, buffer, onFileReceived, onProgress) {
  const { transferId, chunkIndex, payload } = decodeChunkFrame(buffer);
  let transfer = incomingTransfers.get(transferId);

  if (!transfer) {
    console.warn(
      `Received chunk for unknown transfer ${transferId}. Waiting for metadata.`
    );
    return;
  }

  // Check if transfer was accepted
  if (!transfer.accepted) {
    console.warn(`Ignoring chunk for rejected transfer ${transferId}`);
    return;
  }

  if (transfer.completed) {
    sendAck(channel, transferId, chunkIndex, transfer);
    return;
  }

  if (!transfer.chunks[chunkIndex]) {
    transfer.chunks[chunkIndex] = payload;
    transfer.receivedChunks += 1;
    transfer.receivedBytes += payload.byteLength;

    if (onProgress) {
      try {
        onProgress({
          direction: "inbound",
          metadata: transfer.metadata,
          receivedBytes: transfer.receivedBytes,
          totalBytes: transfer.metadata.size,
          receivedChunks: transfer.receivedChunks,
          totalChunks: transfer.metadata.totalChunks,
          chunkIndex,
        });
      } catch (error) {
        console.error("onProgress handler failed", error);
      }
    }
  }

  sendAck(channel, transferId, chunkIndex, transfer);

  if (transfer.receivedChunks === transfer.metadata.totalChunks) {
    finalizeIncomingTransfer(transferId, onFileReceived);
  }
}

function handleControlMessage(text, channel, onFileReceived, onProgress) {
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    console.warn("Ignoring malformed control message", error);
    return;
  }

  switch (message?.type) {
    case "chunk-ack":
      resolveAck(message);
      break;
    case "chunk-error":
      console.error("Chunk error from peer:", message.reason);
      break;
    case "transfer-complete":
      console.log(`Transfer ${message.transferId} complete`);
      break;
    case "file-metadata":
      prepareIncomingTransfer(message.metadata, channel, onFileReceived, onProgress);
      break;
    case "transfer-rejected":
      console.warn(`File transfer rejected: ${message.reason}`);
      alert(`File transfer was rejected by the recipient.`);
      break;
    case "transfer-accepted":
      console.log(`File transfer accepted for ${message.transferId}`);
      break;
    default:
      console.debug("Unhandled control message", message);
  }
}

async function prepareIncomingTransfer(metadata, channel, onFileReceived, onProgress) {
  // Show confirmation dialog
  const fileName = metadata.name || "Unknown file";
  const fileSize = (metadata.size / 1024).toFixed(2);
  const fileSizeUnit = metadata.size < 1024 * 1024 ? "KB" : "MB";
  const displaySize = metadata.size < 1024 * 1024 
    ? fileSize 
    : (metadata.size / (1024 * 1024)).toFixed(2);

  const userAccepted = confirm(
    `Incoming file transfer:\n\n` +
    `File: ${fileName}\n` +
    `Size: ${displaySize} ${fileSizeUnit}\n` +
    `Chunks: ${metadata.totalChunks}\n\n` +
    `Do you want to accept this file?`
  );

  if (!userAccepted) {
    // Send rejection message
    if (channel && channel.readyState === "open") {
      try {
        channel.send(
          JSON.stringify({
            type: "transfer-rejected",
            transferId: metadata.id,
            reason: "User declined the file transfer",
          })
        );
      } catch (error) {
        console.error("Failed to send rejection message", error);
      }
    }
    console.log(`File transfer rejected: ${fileName}`);
    return;
  }

  // User accepted, prepare to receive
  let transfer = incomingTransfers.get(metadata.id);

  if (!transfer) {
    transfer = {
      metadata,
      chunks: new Array(metadata.totalChunks).fill(null),
      receivedChunks: 0,
      receivedBytes: 0,
      completed: false,
      accepted: true,
    };
  } else {
    transfer.metadata = { ...transfer.metadata, ...metadata };
    transfer.chunks = new Array(metadata.totalChunks).fill(null);
    transfer.receivedChunks = 0;
    transfer.receivedBytes = 0;
    transfer.completed = false;
    transfer.accepted = true;
  }

  incomingTransfers.set(metadata.id, transfer);

  // Send acceptance acknowledgment
  if (channel && channel.readyState === "open") {
    try {
      channel.send(
        JSON.stringify({
          type: "transfer-accepted",
          transferId: metadata.id,
        })
      );
    } catch (error) {
      console.error("Failed to send acceptance message", error);
    }
  }
}

const createReceiveHandler = (onFileReceived, onProgress) => (event) => {
  const processBuffer = (buffer) => {
    try {
      handleIncomingChunk(event.target, buffer, onFileReceived, onProgress);
    } catch (error) {
      console.error("Failed to process incoming chunk", error);
      try {
        event.target.send(
          JSON.stringify({
            type: "chunk-error",
            reason: error.message,
          })
        );
      } catch (err) {
        console.error("Failed to send chunk-error", err);
      }
    }
  };

  if (typeof event.data === "string") {
    handleControlMessage(event.data, event.target, onFileReceived, onProgress);
  } else if (event.data instanceof ArrayBuffer) {
    processBuffer(event.data);
  } else if (event.data instanceof Blob) {
    event.data
      .arrayBuffer()
      .then(processBuffer)
      .catch((error) => console.error("Failed reading chunk blob", error));
  }
};

const configureDataChannel = (channel, receiveHandler) => {
  if (!channel) return;

  channel.binaryType = "arraybuffer";
  channel.onopen = () => console.log("Data channel open");
  channel.onclose = () => console.log("Data channel closed");
  channel.onerror = (event) => console.error("Data channel error", event);
  channel.onmessage = receiveHandler;
};

export const initPeerConnection = async ({
  socket,
  targetId,
  registerPeer,
  onFileReceived,
  onProgress,
}) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Signaling server is not connected");
  }

  const peer = new RTCPeerConnection(rtcConfig);
  const receiveHandler = createReceiveHandler(onFileReceived, onProgress);

  const channel = peer.createDataChannel("file");
  configureDataChannel(channel, receiveHandler);

  peer.ondatachannel = (event) => {
    configureDataChannel(event.channel, receiveHandler);
  };

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.send(
        JSON.stringify({
          type: "ice",
          to: targetId,
          candidate: event.candidate,
        })
      );
    }
  };

  const peerObj = {
    peer,
    channel,
    whenChannelReady: Promise.resolve(channel),
    handleSignal: async (message) => {
      if (message.type === "answer") {
        await peer.setRemoteDescription(
          new RTCSessionDescription(message.answer)
        );
      }

      if (message.type === "ice" && message.candidate) {
        await peer.addIceCandidate(new RTCIceCandidate(message.candidate));
      }
    },
  };

  registerPeer(targetId, peerObj);

  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    socket.send(
      JSON.stringify({
        type: "offer",
        to: targetId,
        offer,
      })
    );
  } catch (error) {
    peer.close();
    throw error;
  }

  return peerObj;
};

export const handleOffer = ({
  socket,
  fromId,
  offer,
  registerPeer,
  onFileReceived,
  onProgress,
}) => {
  if (!socket) {
    throw new Error("Signaling server is not connected");
  }

  const peer = new RTCPeerConnection(rtcConfig);
  const receiveHandler = createReceiveHandler(onFileReceived, onProgress);
  let dataChannel = null;
  const channelDeferred = new Promise((resolve) => {
    peer.ondatachannel = (event) => {
      dataChannel = event.channel;
      configureDataChannel(dataChannel, receiveHandler);
      resolve(dataChannel);
    };
  });

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.send(
        JSON.stringify({
          type: "ice",
          to: fromId,
          candidate: event.candidate,
        })
      );
    }
  };

  const peerObj = {
    peer,
    get channel() {
      return dataChannel;
    },
    whenChannelReady: channelDeferred,
    handleSignal: async (message) => {
      if (message.type === "ice" && message.candidate) {
        await peer.addIceCandidate(new RTCIceCandidate(message.candidate));
      }
    },
  };

  registerPeer(fromId, peerObj);

  peer
    .setRemoteDescription(new RTCSessionDescription(offer))
    .then(() => peer.createAnswer())
    .then((answer) => {
      return peer.setLocalDescription(answer).then(() => {
        socket.send(
          JSON.stringify({
            type: "answer",
            to: fromId,
            answer,
          })
        );
      });
    })
    .catch((error) => {
      console.error("Error handling offer", error);
      peer.close();
    });

  return peerObj;
};

function splitFileIntoChunks(file, chunkSize = CHUNK_SIZE) {
  const totalChunks = Math.ceil(file.size / chunkSize) || 1;
  const chunks = new Array(totalChunks);

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    chunks[index] = file.slice(start, end);
  }

  return chunks;
}

function buildFileMetadata(file) {
  const chunks = splitFileIntoChunks(file);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    chunkSize: CHUNK_SIZE,
    totalChunks: chunks.length,
    createdAt: Date.now(),
  };
}

async function sendChunksOverDataChannel({
  channel,
  metadata,
  chunks,
  onProgress,
}) {
  if (!channel || channel.readyState !== "open") {
    throw new Error("Data channel is not open");
  }

  // Send metadata first
  channel.send(
    JSON.stringify({
      type: "file-metadata",
      metadata,
    })
  );

  let sentBytes = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const blob = chunks[index];
    const arrayBuffer = await blob.arrayBuffer();
    const frame = encodeChunkFrame(metadata.id, index, arrayBuffer);

    let attempt = 0;
    while (attempt <= RETRY_LIMIT) {
      try {
        channel.send(frame);
        await waitForAck(metadata.id, index);
        sentBytes += blob.size;

        if (onProgress) {
          onProgress({
            direction: "outbound",
            metadata,
            sentBytes,
            totalBytes: metadata.size,
            sentChunks: index + 1,
            totalChunks: metadata.totalChunks,
            chunkIndex: index,
          });
        }

        break;
      } catch (error) {
        attempt += 1;
        console.warn(`Retrying chunk ${index} (attempt ${attempt})`, error);
        if (attempt > RETRY_LIMIT) {
          throw error;
        }
      }
    }
  }

  try {
    channel.send(
      JSON.stringify({ type: "transfer-complete", transferId: metadata.id })
    );
  } catch (error) {
    console.warn("Failed to send transfer-complete message", error);
  }
}

export const sendFile = async ({ file, targetId, peers, onProgress }) => {
  const peerObj = peers[targetId];

  if (!peerObj) {
    throw new Error(
      "No peer connection found. Please connect to the device first."
    );
  }

  const resolvedChannel =
    peerObj.channel ??
    (typeof peerObj.whenChannelReady?.then === "function"
      ? await peerObj.whenChannelReady
      : null);

  if (!resolvedChannel) {
    throw new Error(
      "No data channel available yet. Please wait for the connection to establish."
    );
  }

  const channel = await ensureChannelOpen(resolvedChannel);

  const metadata = buildFileMetadata(file);
  const chunks = splitFileIntoChunks(file, CHUNK_SIZE);

  await sendChunksOverDataChannel({
    channel,
    metadata,
    chunks,
    onProgress,
  });

  console.log(`File "${file.name}" sent successfully`);
};
