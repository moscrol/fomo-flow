export type DaoTheme = 'paper' | 'ink' | 'night'

const choices: Array<{ id: DaoTheme; label: string; title: string }> = [
  { id: 'paper', label: '纸', title: '纸墨' },
  { id: 'ink', label: '墨', title: '青墨' },
  { id: 'night', label: '夜', title: '夜航' }
]

export function ThemeToggle({
  value,
  onChange
}: {
  value: DaoTheme
  onChange(theme: DaoTheme): void
}) {
  return (
    <div className="theme-toggle" role="group" aria-label="主题">
      {choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          title={choice.title}
          aria-pressed={value === choice.id}
          onClick={() => onChange(choice.id)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  )
}
