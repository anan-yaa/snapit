import "../styles/ReceivingProgress.css";

export default function ReceivingProgress({ transfers }) {
  if (transfers.length === 0) return null;

  const formatFileSize = (bytes) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="receiving-progress">
      <div className="progress-header">
        <i className="bi bi-download" />
        <h4>Receiving Files ({transfers.length})</h4>
      </div>
      
      <div className="transfers-list">
        {transfers.map((transfer) => {
          const progress = Math.min(100, Math.round(
            (transfer.receivedBytes / transfer.totalBytes) * 100
          ));

          return (
            <div key={transfer.id} className="transfer-item">
              <div className="transfer-header">
                <div className="file-icon-small">
                  <i className="bi bi-file-earmark" />
                </div>
                <div className="transfer-info">
                  <div className="transfer-name">{transfer.fileName}</div>
                  <div className="transfer-size">
                    {formatFileSize(transfer.receivedBytes)} / {formatFileSize(transfer.totalBytes)}
                  </div>
                </div>
                <div className="transfer-percent">{progress}%</div>
              </div>

              <div className="progress-bar-container">
                <div 
                  className="progress-bar-fill" 
                  style={{ width: `${progress}%` }}
                >
                  <div className="progress-bar-shimmer" />
                </div>
              </div>

              <div className="transfer-chunks">
                <i className="bi bi-grid-3x3-gap" />
                <span>{transfer.receivedChunks} / {transfer.totalChunks} chunks</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
