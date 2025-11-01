import {
  initPeerConnection,
  sendFile,
  handleOffer,
  prepareIncomingTransfer,
} from "./peer.js";

const socket = new WebSocket("ws://localhost:4000");
let myId = "";
let selectedPeerId = "";
let peers = {};
window.peers = peers;

const myNameTag = document.getElementById("myName");
const userList = document.getElementById("userList");
const fileInput = document.getElementById("fileInput");
const sendFileBtn = document.getElementById("sendFileBtn");

sendFileBtn.addEventListener("click", () => {
  if (selectedPeerId) {
    fileInput.click();
  }
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (file && selectedPeerId) {
    sendFile(file, selectedPeerId, socket);
  }
});

function renderUserList(users) {
  userList.innerHTML = "";
  users.forEach((user) => {
    if (user.id === myId) return;

    const li = document.createElement("li");
    li.textContent = user.name;
    li.style.cursor = "pointer";
    li.onclick = () => {
      selectedPeerId = user.id;
      sendFileBtn.disabled = false;

      // Check if peer connection already exists
      if (peers[user.id]) {
        alert(`Already connected to ${user.name}`);
        return;
      }

      alert(`Connecting to ${user.name}...`);
      initPeerConnection(socket, user.id);
    };
    userList.appendChild(li);
  });
}

socket.onopen = () => {
  console.log("WebSocket connected");
};

socket.onerror = (error) => {
  console.error("WebSocket error:", error);
};

socket.onclose = () => {
  console.log("WebSocket disconnected");
};

socket.onmessage = async ({ data }) => {
  const msg = JSON.parse(data);
  console.log("Received message:", msg);

  if (msg.type === "init") {
    myId = msg.id;
    myNameTag.textContent = `Your Device: ${msg.name}`;
  }

  if (msg.type === "users") {
    renderUserList(msg.users);
  }

  if (msg.type === "offer") {
    // If you are the receiver, handle the offer
    console.log("Received offer from:", msg.from);
    handleOffer(socket, msg.from, msg.offer);
  } else if (msg.type === "answer" || msg.type === "ice") {
    const peer = peers[msg.from];
    if (peer && peer.handleSignal) {
      console.log(`Handling ${msg.type} from ${msg.from}`);
      try {
        await peer.handleSignal(msg);
      } catch (error) {
        console.error(`Error handling ${msg.type}:`, error);
      }
    } else {
      console.warn(`No peer found for ${msg.from} or no handleSignal method`);
    }
  } else if (msg.type === "file-metadata") {
    console.log("Preparing incoming transfer", msg.metadata);
    prepareIncomingTransfer(msg.metadata, msg.from);
  }
};

export function registerPeer(id, peerObj) {
  console.log("Registering peer:", id);
  peers[id] = peerObj;

  // Add connection state logging
  if (peerObj.peer) {
    peerObj.peer.onconnectionstatechange = () => {
      console.log(
        `Peer ${id} connection state: ${peerObj.peer.connectionState}`
      );

      if (peerObj.peer.connectionState === "connected") {
        console.log(`Successfully connected to peer ${id}`);
      } else if (peerObj.peer.connectionState === "failed") {
        console.error(`Connection to peer ${id} failed`);
        delete peers[id]; // Clean up failed connection
      }
    };

    peerObj.peer.onicegatheringstatechange = () => {
      console.log(
        `Peer ${id} ICE gathering state: ${peerObj.peer.iceGatheringState}`
      );
    };

    peerObj.peer.onsignalingstatechange = () => {
      console.log(`Peer ${id} signaling state: ${peerObj.peer.signalingState}`);
    };
  }
}
