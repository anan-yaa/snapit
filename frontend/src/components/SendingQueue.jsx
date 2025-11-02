import "../styles/SendingQueue.css";

export default function SendingQueue({ queue }) {
  if (queue.length === 0) return null;

  const formatFileSize = (bytes) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'pending':
        return 'bi-clock';
      case 'sending':
        return 'bi-arrow-up-circle';
      case 'completed':
        return 'bi-check-circle-fill';
      case 'failed':
        return 'bi-x-circle-fill';
      case 'rejected':
        return 'bi-dash-circle-fill';
      default:
        return 'bi-file-earmark';
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'pending':
        return '#fbbf24';
      case 'sending':
        return '#3b82f6';
      case 'completed':
        return '#10b981';
      case 'failed':
        return '#ef4444';
      case 'rejected':
        return '#f97316';
      default:
        return '#6b7280';
    }
  };

  return (
    <div className="sending-queue">
      <div className="queue-header">
        <i className="bi bi-list-ul" />
        <h4>Sending Queue ({queue.length})</h4>
      </div>
      
      <div className="queue-list">
        {queue.map((item) => (
          <div key={item.id} className={`queue-item ${item.status}`}>
            <div className="item-icon">
              <i 
                className={`bi ${getStatusIcon(item.status)}`}
                style={{ color: getStatusColor(item.status) }}
              />
            </div>
            
            <div className="item-info">
              <div className="item-name">{item.file.name}</div>
              <div className="item-size">{formatFileSize(item.file.size)}</div>
            </div>

            {item.status === 'sending' && (
              <div className="item-progress">
                <div className="progress-circle">
                  <svg width="36" height="36">
                    <circle
                      cx="18"
                      cy="18"
                      r="16"
                      fill="none"
                      stroke="#e5e7eb"
                      strokeWidth="3"
                    />
                    <circle
                      cx="18"
                      cy="18"
                      r="16"
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth="3"
                      strokeDasharray={`${2 * Math.PI * 16}`}
                      strokeDashoffset={`${2 * Math.PI * 16 * (1 - item.progress / 100)}`}
                      strokeLinecap="round"
                      transform="rotate(-90 18 18)"
                    />
                  </svg>
                  <span className="progress-text">{item.progress}%</span>
                </div>
              </div>
            )}

            {item.status === 'pending' && (
              <div className="item-status">
                <span className="status-badge pending">Waiting</span>
              </div>
            )}

            {item.status === 'completed' && (
              <div className="item-status">
                <span className="status-badge completed">Sent</span>
              </div>
            )}

            {item.status === 'failed' && (
              <div className="item-status">
                <span className="status-badge failed">Failed</span>
              </div>
            )}

            {item.status === 'rejected' && (
              <div className="item-status">
                <span className="status-badge rejected">Rejected</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
