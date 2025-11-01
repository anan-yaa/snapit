export let socket;

export function initWebSocket(onMessage) {
  socket = new WebSocket('ws://localhost:4000');
  socket.onmessage = onMessage;
}
