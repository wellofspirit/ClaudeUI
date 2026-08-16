import { useClaudeEvents } from './hooks/useClaudeEvents'
import { useStreamWatch } from './hooks/useStreamWatch'
import { SessionView } from './components/SessionView'

function App(): React.JSX.Element {
  useClaudeEvents()
  useStreamWatch()
  return <SessionView />
}

export default App
