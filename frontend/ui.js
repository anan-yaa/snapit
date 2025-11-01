let selectedPeer = null;

export function showDeviceName(name) {
  document.getElementById('device-name').textContent = name;
}

export function updateUserList(users, myID, connect) {
  const peersDiv = document.getElementById('peers');
  peersDiv.innerHTML = '';
  
  const filteredUsers = users.filter(user => user.id !== myID);
  
  // Enable/disable send button based on whether there are users
  const sendFileBtn = document.getElementById('sendFileBtn');
  if (filteredUsers.length === 0) {
    sendFileBtn.disabled = true;
    sendFileBtn.textContent = 'Select File';
    selectedPeer = null;
  }
  
  filteredUsers.forEach(user => {
    const div = document.createElement('div');
    div.textContent = user.name;
    div.className = 'peer';
    
    // Highlight if this is the selected peer
    if (selectedPeer === user.id) {
      div.classList.add('selected');
    }
    
    div.onclick = () => {
      // Remove selected class from all peers
      document.querySelectorAll('.peer').forEach(p => p.classList.remove('selected'));
      
      // Add selected class to clicked peer
      div.classList.add('selected');
      
      // Update selected peer
      selectedPeer = user.id;
      
      // Enable send button and update text
      sendFileBtn.disabled = false;
      sendFileBtn.textContent = `Send to ${user.name}`;
      
      // Connect to peer
      connect(user.id);
    };
    
    peersDiv.appendChild(div);
  });
}

export function getSelectedPeer() {
  return selectedPeer;
}

export function displayMessage(data) {
  const blob = new Blob([data]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'received_file';
  a.click();
}

// Initialize file sending functionality
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('fileInput');
  const sendFileBtn = document.getElementById('sendFileBtn');
  
  if (sendFileBtn && fileInput) {
    sendFileBtn.addEventListener('click', () => {
      if (!selectedPeer) {
        alert('Please select a device first');
        return;
      }
      fileInput.click();
    });
    
    fileInput.addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (!file || !selectedPeer) return;
      
      // Show sending state
      sendFileBtn.textContent = 'Sending...';
      sendFileBtn.disabled = true;
      
      // TODO: Implement actual file sending through your WebRTC connection
      // This should integrate with your existing connection logic
      console.log('Sending file:', file.name, 'to peer:', selectedPeer);
      
      // Reset after sending (adjust timing based on actual implementation)
      setTimeout(() => {
        sendFileBtn.textContent = 'Select File';
        fileInput.value = '';
        
        // Keep button enabled if peer is still selected
        if (selectedPeer) {
          sendFileBtn.disabled = false;
          const selectedPeerName = document.querySelector('.peer.selected')?.textContent;
          if (selectedPeerName) {
            sendFileBtn.textContent = `Send to ${selectedPeerName}`;
          }
        }
      }, 1000);
    });
  }
});