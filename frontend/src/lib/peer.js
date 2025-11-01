const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const MAX_FILE_SIZE = 16 * 1024; // 16 KB limit for single-message transfers

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

const createReceiveHandler = (onFileReceived) => (event) => {
  try {
    const payload = JSON.parse(event.data);

    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload received");
    }

    const { name, data, type } = payload;
    if (!Array.isArray(data)) {
      throw new Error("Received file data is not an array");
    }

    const byteArray = new Uint8Array(data);
    const blob = new Blob([byteArray], {
      type: type || "application/octet-stream",
    });

    onFileReceived?.({ name, blob });
  } catch (error) {
    console.error("Error processing received data", error);
  }
};

const configureDataChannel = (channel, receiveHandler) => {
  if (!channel) return;

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
}) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Signaling server is not connected");
  }

  const peer = new RTCPeerConnection(rtcConfig);
  const receiveHandler = createReceiveHandler(onFileReceived);

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
}) => {
  if (!socket) {
    throw new Error("Signaling server is not connected");
  }

  const peer = new RTCPeerConnection(rtcConfig);
  const receiveHandler = createReceiveHandler(onFileReceived);
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

  const reader = new FileReader();

  const fileBuffer = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(reader.error || new Error("Error reading file"));
    reader.readAsArrayBuffer(file);
  });

  const uint8Array = new Uint8Array(fileBuffer);

  if (uint8Array.byteLength > MAX_FILE_SIZE) {
    throw new Error(
      "File exceeds the 16 KB transfer limit. Please choose a smaller file."
    );
  }

  onProgress?.({
    sentBytes: uint8Array.byteLength,
    totalBytes: uint8Array.byteLength,
    sentChunks: 1,
    totalChunks: 1,
  });

  channel.send(
    JSON.stringify({
      name: file.name,
      data: Array.from(uint8Array),
      type: file.type,
      size: uint8Array.byteLength,
    })
  );
};
