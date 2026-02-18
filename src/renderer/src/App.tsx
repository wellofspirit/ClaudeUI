import { useClaudeEvents } from './hooks/useClaudeEvents'
import { SessionView } from './components/SessionView'
import { TeamsView } from './components/TeamsView'

function App(): React.JSX.Element {
  useClaudeEvents()
  const isTeamsView = new URLSearchParams(window.location.search).get('view') === 'teams-view'
  return isTeamsView ? <TeamsView /> : <SessionView />
}

export default App
