import { useClaudeEvents } from './hooks/useClaudeEvents'
import { SessionView } from './components/SessionView'

function App(): React.JSX.Element {
  useClaudeEvents()
  return <SessionView />
}

export default App
