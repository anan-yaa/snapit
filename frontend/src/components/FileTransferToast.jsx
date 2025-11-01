import { useEffect, useState } from "react";
import "../styles/FileTransferToast.css";

export default function FileTransferToast({ 
  fileName, 
  fileSize, 
  totalChunks, 
  onAccept, 
  onReject 
}) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Trigger animation
    setIsVisible(true);
  }, []);

  const handleAccept = () => {
    setIsVisible(false);
    setTimeout(() => onAccept(), 300);
  };

  const handleReject = () => {
    setIsVisible(false);
    setTimeout(() => onReject(), 300);
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <>
      <div className={`toast-backdrop ${isVisible ? "visible" : ""}`} />
      <div className={`file-transfer-toast ${isVisible ? "visible" : ""}`}>
        <div className="toast-header">
          <i className="bi bi-file-earmark-arrow-down" />
          <h3>Incoming File Transfer</h3>
        </div>
      
      <div className="toast-body">
        <div className="file-info">
          <div className="info-row">
            <span className="info-label">File:</span>
            <span className="info-value">{fileName}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Size:</span>
            <span className="info-value">{formatFileSize(fileSize)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Chunks:</span>
            <span className="info-value">{totalChunks}</span>
          </div>
        </div>

        <p className="toast-question">Do you want to accept this file?</p>

        <div className="toast-actions">
          <button 
            className="btn-reject" 
            onClick={handleReject}
            type="button"
          >
            <i className="bi bi-x-circle" />
            Reject
          </button>
          <button 
            className="btn-accept" 
            onClick={handleAccept}
            type="button"
          >
            <i className="bi bi-check-circle" />
            Accept
          </button>
        </div>
      </div>
      </div>
    </>
  );
}
