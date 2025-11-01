import { useState, useEffect } from "react";
import "../styles/IncomingFilesDialog.css";

export default function IncomingFilesDialog({ 
  files, 
  onAccept, 
  onReject 
}) {
  const [isVisible, setIsVisible] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState(new Set());

  useEffect(() => {
    setIsVisible(true);
    // Select all files by default
    setSelectedFiles(new Set(files.map(f => f.id)));
  }, [files]);

  const formatFileSize = (bytes) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const toggleFileSelection = (fileId) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(fileId)) {
        newSet.delete(fileId);
      } else {
        newSet.add(fileId);
      }
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(files.map(f => f.id)));
    }
  };

  const handleAccept = () => {
    setIsVisible(false);
    setTimeout(() => {
      const selectedFilesList = files.filter(f => selectedFiles.has(f.id));
      onAccept(selectedFilesList);
    }, 300);
  };

  const handleReject = () => {
    setIsVisible(false);
    setTimeout(() => {
      onReject(files);
    }, 300);
  };

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const selectedCount = selectedFiles.size;
  const allSelected = selectedFiles.size === files.length;

  return (
    <>
      <div className={`dialog-backdrop ${isVisible ? "visible" : ""}`} />
      <div className={`incoming-files-dialog ${isVisible ? "visible" : ""}`}>
        <div className="dialog-header">
          <div className="header-content">
            <i className="bi bi-inbox-fill" />
            <div>
              <h3>Incoming Files</h3>
              <p className="file-count">{files.length} file{files.length !== 1 ? 's' : ''} • {formatFileSize(totalSize)}</p>
            </div>
          </div>
        </div>
        
        <div className="dialog-body">
          <div className="select-all-row">
            <label className="checkbox-container">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
              />
              <span className="checkmark"></span>
              <span className="label-text">
                {allSelected ? 'Deselect All' : 'Select All'}
              </span>
            </label>
            <span className="selected-count">
              {selectedCount} of {files.length} selected
            </span>
          </div>

          <div className="files-list">
            {files.map((file) => (
              <div 
                key={file.id} 
                className={`file-item ${selectedFiles.has(file.id) ? 'selected' : ''}`}
                onClick={() => toggleFileSelection(file.id)}
              >
                <label className="checkbox-container" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(file.id)}
                    onChange={() => toggleFileSelection(file.id)}
                  />
                  <span className="checkmark"></span>
                </label>

                <div className="file-icon">
                  <i className="bi bi-file-earmark" />
                </div>

                <div className="file-details">
                  <div className="file-name">{file.name}</div>
                  <div className="file-meta">
                    <span className="file-size">{formatFileSize(file.size)}</span>
                    <span className="file-chunks">{file.totalChunks} chunks</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="dialog-footer">
          <button 
            className="btn-reject" 
            onClick={handleReject}
            type="button"
          >
            <i className="bi bi-x-circle" />
            Reject All
          </button>
          <button 
            className="btn-accept" 
            onClick={handleAccept}
            type="button"
            disabled={selectedCount === 0}
          >
            <i className="bi bi-check-circle" />
            Accept {selectedCount > 0 ? `(${selectedCount})` : ''}
          </button>
        </div>
      </div>
    </>
  );
}
