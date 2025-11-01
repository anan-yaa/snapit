import { registerPeer } from "./main.js";

const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

const CHUNK_SIZE = 16 * 1024; // 16 KB (safe for WebRTC DataChannel)
const ACK_TIMEOUT_MS = 10_000;
const RETRY_LIMIT = 5;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const outgoingTransfers = new Map(); // id -> { metadata, chunks, channel, socket, targetId, lastAckedIndex }
const incomingTransfers = new Map(); // id -> { metadata, chunks, receivedChunks, receivedBytes, fromId, completed }
const pendingAcks = new Map(); // `${id}:${index}` -> { resolve, reject, timeoutId }

const noop = () => {};

function chunkKey(transferId, chunkIndex) {
  return `${transferId}:${chunkIndex}`;
}

export function splitFileIntoChunks(file, chunkSize = CHUNK_SIZE) {
  const totalChunks = Math.ceil(file.size / chunkSize) || 1;
  const chunks = new Array(totalChunks);

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    chunks[index] = file.slice(start, end);
  }

  return chunks;
}

function buildFileMetadata(file, overrides = {}) {
  const chunks = splitFileIntoChunks(file);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    chunkSize: CHUNK_SIZE,
    totalChunks: chunks.length,
    createdAt: Date.now(),
    ...overrides,
  };
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

function rejectAck(message, reason) {
  if (!message) return;
  const key = chunkKey(message.transferId, message.chunkIndex);
  const pending = pendingAcks.get(key);
  if (!pending) return;
  pendingAcks.delete(key);
  pending.reject(
    reason instanceof Error ? reason : new Error(reason || "Chunk error")
  );
}

function handleControlMessage(text) {
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
      rejectAck(message, message.reason || "Receiver reported chunk error");
      break;
    case "transfer-complete":
      console.log(
        `Transfer ${message.transferId} complete acknowledgement received.`
      );
      break;
    default:
      console.debug("Unhandled control message", message);
  }
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

function finalizeIncomingTransfer(transferId) {
  const transfer = incomingTransfers.get(transferId);
  if (!transfer || transfer.completed) return;
  if (transfer.receivedChunks !== transfer.metadata.totalChunks) return;

  const blob = new Blob(transfer.chunks, {
    type: transfer.metadata.type || "application/octet-stream",
  });

  const url = URL.createObjectURL(blob);

  if (typeof window?.onFileReceived === "function") {
    try {
      window.onFileReceived({ metadata: transfer.metadata, blob, url });
    } catch (error) {
      console.error("onFileReceived handler failed", error);
    }
  } else {
    triggerDownload(transfer.metadata.name, url);
  }

  transfer.completed = true;
  incomingTransfers.delete(transferId);
}

function handleIncomingChunk(channel, buffer) {
  const { transferId, chunkIndex, payload } = decodeChunkFrame(buffer);
  let transfer = incomingTransfers.get(transferId);

  if (!transfer) {
    console.warn(
      `Received chunk for unknown transfer ${transferId}. Consider waiting for metadata.`
    );
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

    if (typeof window?.onFileTransferProgress === "function") {
      try {
        window.onFileTransferProgress({
          direction: "inbound",
          metadata: transfer.metadata,
          receivedBytes: transfer.receivedBytes,
          totalBytes: transfer.metadata.size,
          receivedChunks: transfer.receivedChunks,
          totalChunks: transfer.metadata.totalChunks,
          chunkIndex,
        });
      } catch (error) {
        console.error("onFileTransferProgress handler failed", error);
      }
    }
  }

  sendAck(channel, transferId, chunkIndex, transfer);

  if (transfer.receivedChunks === transfer.metadata.totalChunks) {
    finalizeIncomingTransfer(transferId);
  }
}

function handleChannelMessage(channel, event) {
  const processBuffer = (buffer) => {
    try {
      handleIncomingChunk(channel, buffer);
    } catch (error) {
      console.error("Failed to process incoming chunk", error);
      try {
        channel.send(
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
    handleControlMessage(event.data);
  } else if (event.data instanceof ArrayBuffer) {
    processBuffer(event.data);
  } else if (event.data instanceof Blob) {
    event.data
      .arrayBuffer()
      .then(processBuffer)
      .catch((error) => console.error("Failed reading chunk blob", error));
  }
}

function cleanupOnChannelClose(channel) {
  for (const [key, pending] of pendingAcks.entries()) {
    pending.reject(new Error("Data channel closed"));
    pendingAcks.delete(key);
  }

  for (const [transferId, transfer] of outgoingTransfers.entries()) {
    if (transfer.channel === channel) {
      console.warn(`Transfer ${transferId} interrupted due to channel close`);
    }
  }
}

function setupDataChannel(channel) {
  if (!channel) return;

  channel.binaryType = "arraybuffer";
  channel.addEventListener("open", () => console.log("Data channel open"));
  channel.addEventListener("close", () => {
    console.log("Data channel closed");
    cleanupOnChannelClose(channel);
  });
  channel.addEventListener("error", (event) => {
    console.error("Data channel error", event);
  });
  channel.addEventListener("message", (event) =>
    handleChannelMessage(channel, event)
  );
}

export function initPeerConnection(socket, targetId) {
  const peer = new RTCPeerConnection(config);

  const channel = peer.createDataChannel("file", { ordered: true });
  setupDataChannel(channel);

  peer.ondatachannel = (event) => {
    setupDataChannel(event.channel);
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

  peer
    .createOffer()
    .then((offer) => {
      peer.setLocalDescription(offer);
      socket.send(JSON.stringify({ type: "offer", to: targetId, offer }));
    })
    .catch((error) => console.error("Failed to create offer", error));

  const peerObj = {
    handleSignal: async (msg) => {
      if (msg.type === "answer") {
        await peer.setRemoteDescription(new RTCSessionDescription(msg.answer));
      } else if (msg.type === "ice") {
        await peer.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
    },
    peer,
    channel,
  };

  registerPeer(targetId, peerObj);
}

export function handleOffer(socket, fromId, offer) {
  const peer = new RTCPeerConnection(config);

  let dataChannel = null;
  const channelReady = new Promise((resolve) => {
    peer.ondatachannel = (event) => {
      dataChannel = event.channel;
      setupDataChannel(dataChannel);
      resolve(dataChannel);
    };
  });

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.send(
        JSON.stringify({ type: "ice", to: fromId, candidate: event.candidate })
      );
    }
  };

  peer
    .setRemoteDescription(new RTCSessionDescription(offer))
    .then(async () => {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.send(JSON.stringify({ type: "answer", to: fromId, answer }));
      console.log("Answer sent to:", fromId);
    })
    .catch((error) => {
      console.error("Error handling offer:", error);
    });

  const peerObj = {
    handleSignal: async (msg) => {
      if (msg.type === "ice") {
        await peer.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
    },
    peer,
    get channel() {
      return dataChannel;
    },
    whenChannelReady: channelReady,
  };

  registerPeer(fromId, peerObj);
}

async function sendChunksOverDataChannel({
  channel,
  metadata,
  chunks,
  socket,
  targetId,
  onProgress = noop,
}) {
  if (!channel || channel.readyState !== "open") {
    throw new Error("Data channel is not open");
  }

  outgoingTransfers.set(metadata.id, {
    metadata,
    channel,
    socket,
    targetId,
    nextChunkIndex: 0,
    lastAckedIndex: -1,
  });

  socket.send(
    JSON.stringify({
      type: "file-metadata",
      to: targetId,
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
        outgoingTransfers.set(metadata.id, {
          metadata,
          channel,
          socket,
          targetId,
          nextChunkIndex: index + 1,
          lastAckedIndex: index,
        });
        sentBytes += blob.size;

        onProgress({
          sentBytes,
          totalBytes: metadata.size,
          sentChunks: index + 1,
          totalChunks: metadata.totalChunks,
          chunkIndex: index,
        });

        if (typeof window?.onFileTransferProgress === "function") {
          try {
            window.onFileTransferProgress({
              direction: "outbound",
              metadata,
              sentBytes,
              totalBytes: metadata.size,
              sentChunks: index + 1,
              totalChunks: metadata.totalChunks,
              chunkIndex: index,
            });
          } catch (error) {
            console.error("onFileTransferProgress handler failed", error);
          }
        }

        break;
      } catch (error) {
        attempt += 1;
        console.warn(`Retrying chunk ${index} (attempt ${attempt})`, error);
        if (attempt > RETRY_LIMIT) {
          outgoingTransfers.delete(metadata.id);
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

  outgoingTransfers.delete(metadata.id);
}

export function sendFile(file, targetId, socket) {
  const peerObj = window.peers[targetId];
  if (!peerObj) {
    alert("No peer connection found. Please connect to the peer first.");
    return;
  }

  const channel = peerObj.channel;
  if (!channel) {
    alert("No data channel found. Please wait for connection to establish.");
    return;
  }

  const startTransfer = async () => {
    try {
      const metadata = buildFileMetadata(file);
      const chunks = splitFileIntoChunks(file, CHUNK_SIZE);

      await sendChunksOverDataChannel({
        channel,
        metadata,
        chunks,
        socket,
        targetId,
      });

      console.log(`File "${file.name}" sent successfully`);
    } catch (error) {
      console.error("Error sending file", error);
      alert(`Error sending file: ${error.message}`);
    }
  };

  if (channel.readyState !== "open") {
    alert("Data channel is not open. Waiting for connection to establish...");
    const handleOpen = () => {
      channel.removeEventListener("open", handleOpen);
      startTransfer();
    };
    channel.addEventListener("open", handleOpen, { once: true });
  } else {
    startTransfer();
  }
}

export function prepareIncomingTransfer(metadata, fromId) {
  let transfer = incomingTransfers.get(metadata.id);

  if (!transfer) {
    transfer = {
      metadata: { ...metadata, fromId },
      chunks: new Array(metadata.totalChunks).fill(null),
      receivedChunks: 0,
      receivedBytes: 0,
      fromId,
      completed: false,
    };
  } else {
    transfer.metadata = { ...transfer.metadata, ...metadata, fromId };
    transfer.chunks = new Array(metadata.totalChunks).fill(null);
    transfer.receivedChunks = 0;
    transfer.receivedBytes = 0;
    transfer.completed = false;
    transfer.fromId = fromId;
  }

  incomingTransfers.set(metadata.id, transfer);

  if (typeof window?.onIncomingFileMetadata === "function") {
    try {
      window.onIncomingFileMetadata(transfer.metadata, fromId);
    } catch (error) {
      console.error("onIncomingFileMetadata handler failed", error);
    }
  }
}

export function getStoredTransferState(transferId) {
  return (
    outgoingTransfers.get(transferId) ||
    incomingTransfers.get(transferId) ||
    null
  );
}

export function reconstructFile(chunks, metadata) {
  const blob = new Blob(chunks, {
    type: metadata?.type || "application/octet-stream",
  });
  return new File([blob], metadata?.name || "file", {
    type: metadata?.type || "application/octet-stream",
    lastModified: metadata?.createdAt || Date.now(),
  });
}
