// ---------------------------------------------------------------------------
// Diff review comment types
// ---------------------------------------------------------------------------

export interface DiffComment {
  id: string
  filePath: string
  lineNumber: number
  /** End line when a range is selected (inclusive). Equals lineNumber for single-line. */
  endLineNumber: number
  side: 'old' | 'new'
  lineContent: string
  comment: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// Plan review comment types
// ---------------------------------------------------------------------------

export interface PlanComment {
  id: string
  /** The exact text the user highlighted in the rendered plan */
  selectedText: string
  /** 1-based start line of the selection in the raw plan markdown */
  lineNumber: number
  /** 1-based end line (inclusive). Equals lineNumber for single-line selections. */
  endLineNumber: number
  /** Index of the plan section this comment belongs to (for UI placement) */
  sectionIndex: number
  comment: string
  createdAt: number
}

export interface PlanReviewData {
  planContent: string
  /** The approval this review answers. */
  approvalRequestId: string
  comments: PlanComment[]
}
