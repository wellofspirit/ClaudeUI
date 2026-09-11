// GENERATED narrow maps; payloads are exact upstream types.
export interface CodexMethods {
  "account/read": { params: import("./v2/GetAccountParams").GetAccountParams; result: import("./v2/GetAccountResponse").GetAccountResponse };
  "account/login/start": { params: import("./v2/LoginAccountParams").LoginAccountParams; result: import("./v2/LoginAccountResponse").LoginAccountResponse };
  "account/login/cancel": { params: import("./v2/CancelLoginAccountParams").CancelLoginAccountParams; result: import("./v2/CancelLoginAccountResponse").CancelLoginAccountResponse };
  "account/logout": { params: undefined; result: import("./v2/LogoutAccountResponse").LogoutAccountResponse };
  "model/list": { params: import("./v2/ModelListParams").ModelListParams; result: import("./v2/ModelListResponse").ModelListResponse };
  "config/read": { params: import("./v2/ConfigReadParams").ConfigReadParams; result: import("./v2/ConfigReadResponse").ConfigReadResponse };
  "configRequirements/read": { params: undefined; result: import("./v2/ConfigRequirementsReadResponse").ConfigRequirementsReadResponse };
  "thread/settings/update": { params: import("./v2/ThreadSettingsUpdateParams").ThreadSettingsUpdateParams; result: import("./v2/ThreadSettingsUpdateResponse").ThreadSettingsUpdateResponse };
  "thread/start": { params: import("./v2/ThreadStartParams").ThreadStartParams; result: import("./v2/ThreadStartResponse").ThreadStartResponse };
  "thread/read": { params: import("./v2/ThreadReadParams").ThreadReadParams; result: import("./v2/ThreadReadResponse").ThreadReadResponse };
  "thread/resume": { params: import("./v2/ThreadResumeParams").ThreadResumeParams; result: import("./v2/ThreadResumeResponse").ThreadResumeResponse };
  "thread/fork": { params: import("./v2/ThreadForkParams").ThreadForkParams; result: import("./v2/ThreadForkResponse").ThreadForkResponse };
  "thread/list": { params: import("./v2/ThreadListParams").ThreadListParams; result: import("./v2/ThreadListResponse").ThreadListResponse };
  "thread/delete": { params: import("./v2/ThreadDeleteParams").ThreadDeleteParams; result: import("./v2/ThreadDeleteResponse").ThreadDeleteResponse };
  "thread/archive": { params: import("./v2/ThreadArchiveParams").ThreadArchiveParams; result: import("./v2/ThreadArchiveResponse").ThreadArchiveResponse };
  "thread/turns/list": { params: import("./v2/ThreadTurnsListParams").ThreadTurnsListParams; result: import("./v2/ThreadTurnsListResponse").ThreadTurnsListResponse };
  "thread/items/list": { params: import("./v2/ThreadItemsListParams").ThreadItemsListParams; result: import("./v2/ThreadItemsListResponse").ThreadItemsListResponse };
  "turn/start": { params: import("./v2/TurnStartParams").TurnStartParams; result: import("./v2/TurnStartResponse").TurnStartResponse };
  "turn/steer": { params: import("./v2/TurnSteerParams").TurnSteerParams; result: import("./v2/TurnSteerResponse").TurnSteerResponse };
  "turn/interrupt": { params: import("./v2/TurnInterruptParams").TurnInterruptParams; result: import("./v2/TurnInterruptResponse").TurnInterruptResponse };
}
export interface CodexServerMethods {
  "item/commandExecution/requestApproval": { params: import("./v2/CommandExecutionRequestApprovalParams").CommandExecutionRequestApprovalParams; result: import("./v2/CommandExecutionRequestApprovalResponse").CommandExecutionRequestApprovalResponse };
  "item/fileChange/requestApproval": { params: import("./v2/FileChangeRequestApprovalParams").FileChangeRequestApprovalParams; result: import("./v2/FileChangeRequestApprovalResponse").FileChangeRequestApprovalResponse };
  "item/tool/requestUserInput": { params: import("./v2/ToolRequestUserInputParams").ToolRequestUserInputParams; result: import("./v2/ToolRequestUserInputResponse").ToolRequestUserInputResponse };
  "item/permissions/requestApproval": { params: import("./v2/PermissionsRequestApprovalParams").PermissionsRequestApprovalParams; result: import("./v2/PermissionsRequestApprovalResponse").PermissionsRequestApprovalResponse };
  "item/tool/call": { params: import("./v2/DynamicToolCallParams").DynamicToolCallParams; result: import("./v2/DynamicToolCallResponse").DynamicToolCallResponse };
}
export interface CodexNotifications {
  "account/login/completed": import("./v2/AccountLoginCompletedNotification").AccountLoginCompletedNotification;
  "account/updated": import("./v2/AccountUpdatedNotification").AccountUpdatedNotification;
  "thread/started": import("./v2/ThreadStartedNotification").ThreadStartedNotification;
  "thread/status/changed": import("./v2/ThreadStatusChangedNotification").ThreadStatusChangedNotification;
  "thread/settings/updated": import("./v2/ThreadSettingsUpdatedNotification").ThreadSettingsUpdatedNotification;
  "thread/tokenUsage/updated": import("./v2/ThreadTokenUsageUpdatedNotification").ThreadTokenUsageUpdatedNotification;
  "item/reasoning/summaryTextDelta": import("./v2/ReasoningSummaryTextDeltaNotification").ReasoningSummaryTextDeltaNotification;
  "item/reasoning/textDelta": import("./v2/ReasoningTextDeltaNotification").ReasoningTextDeltaNotification;
  "item/commandExecution/outputDelta": import("./v2/CommandExecutionOutputDeltaNotification").CommandExecutionOutputDeltaNotification;
  "turn/started": import("./v2/TurnStartedNotification").TurnStartedNotification;
  "turn/completed": import("./v2/TurnCompletedNotification").TurnCompletedNotification;
  "item/started": import("./v2/ItemStartedNotification").ItemStartedNotification;
  "item/completed": import("./v2/ItemCompletedNotification").ItemCompletedNotification;
  "item/agentMessage/delta": import("./v2/AgentMessageDeltaNotification").AgentMessageDeltaNotification;
  "serverRequest/resolved": import("./v2/ServerRequestResolvedNotification").ServerRequestResolvedNotification;
}
