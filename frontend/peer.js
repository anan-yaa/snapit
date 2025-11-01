import { registerPeer } from "./main.js";

const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export function initPeerConnection(socket, targetId) {
  const peer = new RTCPeerConnection(config);
  
  // Only the initiator creates the data channel
  const channel = peer.createDataChannel("file");
  
  channel.onopen = () => console.log("Data channel open");
  channel.onclose = () => console.log("Data channel closed");
  channel.onmessage = receiveData;
  
  // The receiver listens for the data channel
  peer.ondatachannel = (e) => {
    const receivedChannel = e.channel;
    receivedChannel.onopen = () => console.log("Received data channel open");
    receivedChannel.onclose = () => console.log("Received data channel closed");
    receivedChannel.onmessage = receiveData;
  };
  
  peer.onicecandidate = (e) => {
    if (e.candidate) {
      socket.send(
        JSON.stringify({ type: "ice", to: targetId, candidate: e.candidate })
      );
    }
  };
  
  peer.createOffer().then((offer) => {
    peer.setLocalDescription(offer);
    socket.send(JSON.stringify({ type: "offer", to: targetId, offer }));
  });
  
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
  
  // Store the data channel reference for the receiver
  let dataChannel = null;
  
  peer.ondatachannel = (e) => {
    dataChannel = e.channel;
    dataChannel.onopen = () => console.log("Received data channel open");
    dataChannel.onclose = () => console.log("Received data channel closed");
    dataChannel.onmessage = receiveData;
  };
  
  peer.onicecandidate = (e) => {
    if (e.candidate) {
      socket.send(
        JSON.stringify({ type: "ice", to: fromId, candidate: e.candidate })
      );
    }
  };
  
  peer.setRemoteDescription(new RTCSessionDescription(offer)).then(async () => {
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    socket.send(JSON.stringify({ type: "answer", to: fromId, answer }));
    console.log("Answer sent to:", fromId);
  }).catch(error => {
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
      return dataChannel; // Use getter to return the current channel
    }
  };
  
  registerPeer(fromId, peerObj);
}

export function sendFile(file, targetId, socket) {
  // Use the existing peer and channel
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
  
  console.log("Channel ready state:", channel.readyState);
  
  if (channel.readyState !== "open") {
    alert("Data channel is not open. Please wait for connection to establish.");
    channel.onopen = () => {
      console.log("Channel opened, sending file...");
      sendFileOverChannel(file, channel);
    };
  } else {
    sendFileOverChannel(file, channel);
  }
}

function receiveData(event) {
  console.log("Received data channel message", event.data);
  
  try {
    const { name, data } = JSON.parse(event.data);
    
    // Convert array back to Uint8Array
    const uint8Array = new Uint8Array(data);
    const blob = new Blob([uint8Array], {
      type: "application/octet-stream",
    });
    
    // Create download URL
    const url = URL.createObjectURL(blob);
    
    // Create and trigger download
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    
    // Clean up
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    
    alert(`File "${name}" received and downloaded.`);
    
  } catch (error) {
    console.error("Error processing received file:", error);
    alert("Error processing received file");
  }
}

function sendFileOverChannel(file, channel) {
  const reader = new FileReader();
  reader.onload = () => {
    const message = JSON.stringify({
      name: file.name,
      data: Array.from(new Uint8Array(reader.result)),
    });
    
    // Check if message is too large for a single send
    const maxChunkSize = 16384; // 16KB chunks
    if (message.length > maxChunkSize) {
      console.warn("File is large, consider implementing chunked transfer");
    }
    
    try {
      channel.send(message);
      console.log(`File "${file.name}" sent successfully`);
    } catch (error) {
      console.error("Error sending file:", error);
      alert("Error sending file: " + error.message);
    }
  };
  
  reader.onerror = () => {
    console.error("Error reading file");
    alert("Error reading file");
  };
  
  reader.readAsArrayBuffer(file);
}