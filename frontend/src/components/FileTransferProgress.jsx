import { useEffect, useState } from "react";
import "../styles/FileTransferProgress.css";

export default function FileTransferProgress({ 
  fileName, 
  progress, 
  receivedBytes, 
  totalBytes,
  receivedChunks,
  totalChunks
}) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  const formatFileSize = (bytes) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const progressPercent = Math.min(100, Math.round(progress));

  return (
    <>
      <div className={`progress-backdrop ${isVisible ? "visible" : ""}`} />
      <div className={`file-transfer-progress ${isVisible ? "visible" : ""}`}>
        <div className="progress-header">
          <i className="bi bi-download" />
          <h3>Receiving File</h3>
        </div>
        
        <div className="progress-body">
          <div className="file-name">
            <i className="bi bi-file-earmark" />
            <span>{fileName}</span>
          </div>

          <div className="progress-bar-container">
            <div 
              className="progress-bar-fill" 
              style={{ width: `${progressPercent}%` }}
            >
              <div className="progress-bar-shimmer" />
            </div>
          </div>

          <div className="progress-stats">
            <span className="progress-percent">{progressPercent}%</span>
            <span className="progress-size">
              {formatFileSize(receivedBytes)} / {formatFileSize(totalBytes)}
            </span>
          </div>

          <div className="progress-chunks">
            <i className="bi bi-grid-3x3-gap" />
            <span>Chunks: {receivedChunks} / {totalChunks}</span>
          </div>

          <div className="loading-dots">
            <span className="dot"></span>
            <span className="dot"></span>
            <span className="dot"></span>
          </div>
        </div>
      </div>
    </>
  );
}
