export function DaoMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`dao-mark dao-mark-${size}`} aria-hidden="true">
      <span>道</span>
    </span>
  )
}
