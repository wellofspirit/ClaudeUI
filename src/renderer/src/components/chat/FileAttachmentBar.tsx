import type { FileAttachment } from '../../../../shared/types'

interface FileAttachmentBarProps {
  attachments: FileAttachment[]
  onRemove: (id: string) => void
}

export function FileAttachmentBar({
  attachments,
  onRemove
}: FileAttachmentBarProps): React.JSX.Element | null {
  if (attachments.length === 0) return null

  return (
    <div className="flex gap-2 px-3 pt-2.5 pb-0.5 overflow-x-auto">
      {attachments.map((file) => (
        <div key={file.id} className={`relative shrink-0 rounded-lg overflow-hidden border border-border group/file ${file.fileType === 'pdf' ? 'flex items-center gap-1.5 px-2.5 h-10 bg-bg-hover' : 'w-16 h-16'}`}>
          {file.fileType === 'pdf' ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-red-400 shrink-0">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="text-[11px] text-text-secondary max-w-[100px] truncate">{file.fileName}</span>
            </>
          ) : (
            <img src={file.previewUrl} alt={file.fileName} className="w-full h-full object-cover" />
          )}
          <button
            onClick={() => onRemove(file.id)}
            className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 hover:bg-black/80 rounded-full flex items-center justify-center opacity-0 group-hover/file:opacity-100 transition-opacity cursor-pointer"
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
