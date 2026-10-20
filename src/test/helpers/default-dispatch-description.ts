/**
 * A `CrossEngineDispatcher` for tests that launch X-Agents without caring about their label.
 * A NEW launch must carry a `description` (the tool registrations require it and the dispatcher
 * refuses one without), so this gives every new launch a default one. A request that names its own
 * `description` (blank included, to test the refusal) is left as it is, and so is a continuation
 * or a message (`sessionId` / `message` set), which never needs one.
 */
import type {
  CrossEngineDispatcher,
  DispatchRequest
} from '../../core/services/cross-engine-dispatcher'

export const DEFAULT_TEST_DESCRIPTION = 'Test task'

export function withDefaultDescription<T extends CrossEngineDispatcher>(dispatcher: T): T {
  const dispatch = dispatcher.dispatch.bind(dispatcher)
  dispatcher.dispatch = (req: DispatchRequest, ctx) =>
    dispatch(
      req.sessionId || req.message || 'description' in req
        ? req
        : { ...req, description: DEFAULT_TEST_DESCRIPTION },
      ctx
    )
  return dispatcher
}
