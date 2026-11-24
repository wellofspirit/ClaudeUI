/**
 * The detached relaunch helpers, as fixed script text bundled into main. Every
 * parameter comes from the job file (`job.ts`); nothing variable is ever
 * spliced into a script or a command line (design review ruling 9).
 *
 * Algorithm (both scripts; every step is appended, timestamped, to `<t>.log`):
 *   0. write `<t>.ready`. Every exit path writes `<t>.result.json` (temp +
 *      rename) and releases `lock/` (only when it is this job's).
 *   1. wait for the old pid (`waitPidSec`); timeout → `aborted`, nothing touched.
 *   2. Windows: wait `lockWaitSec` for processes running from the install to exit,
 *      stop the rest BY PID, wait `killWaitSec`; still there → launch the install
 *      unchanged, `aborted`.
 *   3. swap preflight: both markers valid, backup and failed paths free, a probe
 *      rename of the staged dir. Any failure → launch the install unchanged, `failed`.
 *   4. swap: install → backup (Windows: retried), staged → install (no retry);
 *      a failed second rename puts the backup back, or launches it in place.
 *   5. launch (`{app}` in the job's launch argv → the folder).
 *   6. after `launchCheckSec` with nothing running from the install, launch once more.
 *   7. wait `healthSec` for a health record newer than the job (swap: of `toVersion`).
 *   8. none: relaunch → `no-health`; swap → stop what started from the install
 *      after the swap, move the new build to the failed path, put the backup
 *      back, launch it, `rolled-back`.
 *
 * Processes are chosen by EXACT executable path under the install and stopped
 * by pid; never by name (`bun-claude` also runs agent sessions on this machine).
 * Nothing here deletes recursively: the helpers only rename.
 */

/** `${D}{` in the bash text: a template literal would read `${` as an interpolation. */
const D = '$'

/** macOS / Linux: run as `/bin/bash -c BASH_HELPER claudeui-relaunch <t>.job.sh`. */
export const BASH_HELPER = String.raw`
set -u
trap '' HUP
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
JOB_FILE=$1
. "$JOB_FILE" || exit 70
S=$JOB_STATE_DIR
T=$JOB_TOKEN
LOG="$S/$T.log"
DONE=0
BEFORE=""
SWAP_DONE=0
HEALTH="$S/health/$JOB_INSTALL_KEY.json"
MARKER_REL='Contents/Resources/claudeui-install.json'

now_ms() { echo $(( $(date +%s) * 1000 )); }
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null; }
put() { printf '%s' "$2" > "$1.$$.tmp" && mv -f "$1.$$.tmp" "$1"; }
jstr() {
  local s=$1
  s=${D}{s//\\/\\\\}
  s=${D}{s//\"/\\\"}
  s=${D}{s//$'\n'/\\n}
  s=${D}{s//$'\r'/\\r}
  s=${D}{s//$'\t'/\\t}
  printf '"%s"' "$s"
}
release_lock() {
  local own="$S/lock/owner.json"
  if [ -f "$own" ] && grep -q "\"token\":\"$T\"" "$own"; then
    rm -f "$own"
    rmdir "$S/lock" 2>/dev/null
  fi
}
finish() {
  local status=$1 reason=${D}{2:-} body
  body="{\"token\":$(jstr "$T"),\"status\":$(jstr "$status"),\"mode\":$(jstr "$JOB_MODE"),\"fromVersion\":$(jstr "$JOB_FROM_VERSION"),\"toVersion\":$(jstr "$JOB_TO_VERSION")"
  if [ -n "$reason" ]; then body="$body,\"reason\":$(jstr "$reason")"; fi
  body="$body,\"at\":$(now_ms)}"
  put "$S/$T.result.json" "$body"
  log "result: $status${D}{reason:+ ($reason)}"
  DONE=1
  release_lock
  exit 0
}
# Stopped part-way (a signal, an unexpected error): never leave the install
# moved aside with nothing in its place, nor the user with nothing running once
# the old process is gone. After the swap landed the outcome is 'interrupted':
# the next boot of the install records it 'updated' when it is the new version.
on_exit() {
  [ "$DONE" = 0 ] || return
  if [ "$JOB_MODE" = swap ] && ! exists "$JOB_INSTALL" && exists "$JOB_BACKUP"; then
    ren "$JOB_BACKUP" "$JOB_INSTALL" && launch "$JOB_INSTALL"
  elif ! alive "$JOB_PID" && exists "$JOB_INSTALL" && [ -z "$(pids_under "$JOB_INSTALL")" ]; then
    launch "$JOB_INSTALL"
  fi
  if [ "$SWAP_DONE" = 1 ]; then
    finish interrupted "the relaunch helper stopped after the swap, before the new build reported healthy"
  fi
  finish failed "the relaunch helper stopped unexpectedly"
}
trap on_exit EXIT
trap 'exit 143' TERM INT

exists() { [ -e "$1" ] || [ -L "$1" ]; }
alive() { kill -0 "$1" 2>/dev/null; }

# pids whose executable is under "$1/" (exact path prefix, never a name).
pids_under() {
  local root="$1/" pid exe d
  if [ -e /proc/self/exe ]; then
    for d in /proc/[0-9]*; do
      exe=$(readlink "$d/exe" 2>/dev/null) || continue
      case "$exe" in "$root"*) echo "${D}{d#/proc/}" ;; esac
    done
  else
    ps -axww -o pid=,comm= 2>/dev/null | while read -r pid exe; do
      case "$exe" in "$root"*) echo "$pid" ;; esac
    done
  fi
}

marker_ok() {
  local f="$1/$MARKER_REL" t
  [ -f "$f" ] || return 1
  t=$(tr -d ' \n\r\t' < "$f" 2>/dev/null) || return 1
  case "$t" in *'"product":"com.claudeui.app"'*) ;; *) return 1 ;; esac
  case "$t" in *'"kind":"desktop"'*) ;; *) return 1 ;; esac
  case "$t" in *'"schema":1,'* | *'"schema":1}'*) return 0 ;; esac
  return 1
}

# {app} in an argument → the folder; plain string splicing (no pattern replacement).
sub_app() {
  local a=$1 out=""
  while :; do
    case "$a" in
      *'{app}'*) out="$out${D}{a%%\{app\}*}$2"; a=${D}{a#*\{app\}} ;;
      *) SUB_OUT="$out$a"; return ;;
    esac
  done
}
launch() {
  local a args=() shown=() prev=""
  for a in "${D}{JOB_LAUNCH[@]}"; do sub_app "$a" "$1"; args+=("$SUB_OUT"); done
  # The log keeps only the NAME of each carried variable: a proxy URL can hold a password.
  for a in "${D}{args[@]}"; do
    if [ "$prev" = "--env" ]; then shown+=("${D}{a%%=*}=..."); else shown+=("$a"); fi
    prev=$a
  done
  log "launch: ${D}{shown[*]}"
  ( cd "$HOME" 2>/dev/null || cd /; exec "${D}{args[@]}" ) </dev/null >/dev/null 2>&1 &
}

# Rename that refuses an existing destination (mv would nest into a directory).
ren() {
  if exists "$2"; then log "refusing to rename onto existing $2"; return 1; fi
  if mv -- "$1" "$2" 2>>"$LOG"; then log "renamed $1 -> $2"; return 0; fi
  log "rename $1 -> $2 failed"
  return 1
}

healthy() {
  local t at ver
  [ -f "$HEALTH" ] || return 1
  t=$(tr -d '\n\r' < "$HEALTH" 2>/dev/null) || return 1
  at=$(printf '%s' "$t" | sed -n 's/.*"at":\([0-9][0-9]*\).*/\1/p')
  [ -n "$at" ] || return 1
  [ "$at" -gt "$JOB_STARTED_AT" ] || return 1
  if [ "$JOB_MODE" = swap ]; then
    ver=$(printf '%s' "$t" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
    [ "$ver" = "$JOB_TO_VERSION" ] || return 1
  fi
  return 0
}

fail_unchanged() {
  log "preflight failed: $1"
  launch "$JOB_INSTALL"
  finish failed "$1"
}

# Stop what runs from the install and was not running before the swap (by pid).
stop_new() {
  local p list="" left waited=0
  for p in $(pids_under "$JOB_INSTALL"); do
    case " $BEFORE " in *" $p "*) ;; *) list="$list $p" ;; esac
  done
  [ -n "$list" ] || return 0
  log "stopping:$list"
  kill -TERM $list 2>/dev/null
  while [ "$waited" -lt $(( JOB_KILL_WAIT_SEC * 5 )) ]; do
    left=""
    for p in $list; do alive "$p" && left="$left $p"; done
    [ -n "$left" ] || return 0
    sleep 0.2
    waited=$(( waited + 1 ))
  done
  log "killing:$left"
  kill -KILL $left 2>/dev/null
}

# 0. alive
put "$S/$T.ready" "$(now_ms)"
log "helper started: mode=$JOB_MODE pid=$JOB_PID install=$JOB_INSTALL"

# 1. the old process must be gone before anything is touched
deadline=$(( $(date +%s) + JOB_WAIT_PID_SEC ))
while alive "$JOB_PID"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then finish aborted "ClaudeUI did not quit"; fi
  sleep 0.2
done
log "process $JOB_PID exited"

# 3-4. swap
if [ "$JOB_MODE" = swap ]; then
  marker_ok "$JOB_INSTALL" || fail_unchanged "the install no longer carries a ClaudeUI marker"
  [ -d "$JOB_STAGED" ] && [ ! -L "$JOB_STAGED" ] || fail_unchanged "the staged build is missing"
  marker_ok "$JOB_STAGED" || fail_unchanged "the staged build carries no ClaudeUI marker"
  exists "$JOB_BACKUP" && fail_unchanged "the backup path already exists"
  exists "$JOB_FAILED" && fail_unchanged "the failed-build path already exists"
  ren "$JOB_STAGED" "$JOB_STAGED.probe" || fail_unchanged "the staged build cannot be renamed"
  ren "$JOB_STAGED.probe" "$JOB_STAGED" || fail_unchanged "the staged build could not be renamed back"
  BEFORE=" $(pids_under "$JOB_INSTALL" | tr '\n' ' ') "
  ren "$JOB_INSTALL" "$JOB_BACKUP" || fail_unchanged "the install could not be moved aside"
  if ! ren "$JOB_STAGED" "$JOB_INSTALL"; then
    if ! exists "$JOB_INSTALL" && ren "$JOB_BACKUP" "$JOB_INSTALL"; then
      launch "$JOB_INSTALL"
      finish failed "the staged build could not be moved into place"
    fi
    launch "$JOB_BACKUP"
    finish failed "the staged build could not be moved into place, and the previous version could not be put back: it is running from $JOB_BACKUP"
  fi
  SWAP_DONE=1
  log "swapped"
fi

# 5-7. launch, re-launch once if nothing came up, wait for health
launch "$JOB_INSTALL"
launched=$(date +%s)
retried=0
while :; do
  if healthy; then
    if [ "$JOB_MODE" = swap ]; then finish updated; fi
    finish ok
  fi
  now=$(date +%s)
  if [ "$retried" = 0 ] && [ "$now" -ge $(( launched + JOB_LAUNCH_CHECK_SEC )) ]; then
    retried=1
    if [ -z "$(pids_under "$JOB_INSTALL")" ]; then
      log "nothing runs from the install; launching once more"
      launch "$JOB_INSTALL"
    fi
  fi
  [ "$now" -ge $(( launched + JOB_HEALTH_SEC )) ] && break
  sleep 0.5
done

# 8. no health
if [ "$JOB_MODE" != swap ]; then
  finish no-health "ClaudeUI did not report healthy within $JOB_HEALTH_SEC s"
fi
log "the new build did not report healthy; rolling back"
stop_new
ren "$JOB_INSTALL" "$JOB_FAILED" || log "could not move the new build aside"
if ! exists "$JOB_INSTALL" && ren "$JOB_BACKUP" "$JOB_INSTALL"; then
  launch "$JOB_INSTALL"
  finish rolled-back "the new build did not report healthy within $JOB_HEALTH_SEC s"
fi
launch "$JOB_BACKUP"
finish failed "the new build did not report healthy within $JOB_HEALTH_SEC s, and the previous version could not be put back: it is running from $JOB_BACKUP"
`

/**
 * Windows: run as `powershell.exe -EncodedCommand <this, compacted>` with the
 * job's path in `CLAUDEUI_RELAUNCH_JOB`. Kept small: the encoded form must stay
 * well under the 32 767-character command line ({@link POWERSHELL_ENCODED_LIMIT}).
 */
const POWERSHELL_SOURCE = String.raw`
$ErrorActionPreference='Continue'
$U8=New-Object Text.UTF8Encoding $false
# The job is BOM-less UTF-8: never let Windows PowerShell read it in the ANSI code page.
# Unreadable job: stop before anything (the trap below covers the whole script).
try{$j=[IO.File]::ReadAllText($env:CLAUDEUI_RELAUNCH_JOB,[Text.Encoding]::UTF8)|ConvertFrom-Json}catch{exit 70}
if(-not $j.stateDir -or -not $j.token -or -not $j.installPath){exit 70}
$S=$j.stateDir;$T=$j.token;$to=$j.timeouts;$I=$j.installPath
$T0=[DateTimeOffset]::FromUnixTimeMilliseconds([int64]$j.startedAt).LocalDateTime
$PB='and the previous version could not be put back: it is running from '
$IR='the relaunch helper stopped after the swap, before the new build reported healthy'
$script:Done=$false;$script:Swapped=$false
function NowMs{[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
function L($m){try{[IO.File]::AppendAllText("$S\$T.log",('{0} {1}{2}' -f [DateTime]::UtcNow.ToString('o'),$m,[Environment]::NewLine),$U8)}catch{}}
# Read UTF-8 without locking out a writer's rename (share ReadWrite and Delete).
function RT($p){$f=[IO.FileStream]::new($p,'Open','Read','ReadWrite, Delete');try{[IO.StreamReader]::new($f,$U8).ReadToEnd()}finally{$f.Dispose()}}
function Put($f,$t){$tmp="$f.$PID.tmp";[IO.File]::WriteAllText($tmp,[string]$t,$U8);Move-Item -LiteralPath $tmp -Destination $f -Force}
function Fin($st,$r){
$o=[ordered]@{token=$T;status=$st;mode=$j.mode;fromVersion=$j.fromVersion;toVersion=$j.toVersion}
if($r){$o.reason=[string]$r}
$o.at=NowMs
Put "$S\$T.result.json" ($o|ConvertTo-Json -Compress)
L "result: $st $r"
$script:Done=$true
$own="$S\lock\owner.json"
try{if(((RT $own)|ConvertFrom-Json).token -eq $T){Remove-Item -LiteralPath $own;[IO.Directory]::Delete("$S\lock")}}catch{}
exit 0
}
# The old process is gone, or its pid now names a process started after the job (reused).
function Old{$p=Get-Process -Id $j.pid -ErrorAction SilentlyContinue;if(-not $p){return $false};$s=$p.StartTime;if($null -eq $s){return $false};$s -le $T0}
# Stopped part-way: put a moved-aside install back, never leave nothing running.
trap{if(-not $script:Done){
if($j.mode -eq 'swap' -and -not (Test-Path -LiteralPath $I) -and (Test-Path -LiteralPath $j.backupPath) -and (MoveDir $j.backupPath $I 10)){Go $I}elseif(-not (Old) -and (Test-Path -LiteralPath $I) -and -not (Under $I).Count){Go $I}
if($script:Swapped){Fin 'interrupted' $IR}
Fin 'failed' "the relaunch helper stopped: $_"}}
# Processes whose executable is under the folder (exact path prefix, never a name).
function Under($d){$r=$d.TrimEnd('\')+'\';@(Get-CimInstance Win32_Process|?{$_.ExecutablePath -and $_.ExecutablePath.StartsWith($r,[StringComparison]::OrdinalIgnoreCase)})}
function WaitGone($d,$sec){$dl=(Get-Date).AddSeconds($sec);while((Under $d).Count -and (Get-Date) -lt $dl){Start-Sleep -Milliseconds 500}}
function Go($app){$a=@($j.launch|%{$_.Replace('{app}',$app)});L "launch: $($a -join ' ')";$p=@{FilePath=$a[0];WorkingDirectory=$HOME};if($a.Count -gt 1){$p.ArgumentList=@($a[1..($a.Count-1)]|%{if($_ -match '\s'){'"'+$_+'"'}else{$_}})};try{Start-Process @p}catch{L "launch failed: $_"}}
function MOk($d){
try{$m=[IO.File]::ReadAllText("$d\resources\claudeui-install.json",[Text.Encoding]::UTF8)|ConvertFrom-Json}catch{return $false}
if($m.schema -ne 1 -or $m.product -ne 'com.claudeui.app' -or $m.kind -ne 'desktop'){return $false}
$e=@($m.entries|%{"$_".ToLowerInvariant()})
foreach($n in (Get-ChildItem -LiteralPath $d -Force -Name)){if($e -notcontains $n.ToLowerInvariant()){L "unexpected entry in $($d): $n";return $false}}
$true}
# Rename a folder, refusing an existing destination; tried $n times a second apart.
# Not "Ren": a built-in alias (Rename-Item) would win over a function of that name.
function MoveDir($a,$b,$n){for($i=1;;$i++){if(Test-Path -LiteralPath $b){L "refusing: $b exists";return $false};try{[IO.Directory]::Move($a,$b);L "renamed $a -> $b";return $true}catch{L "rename $a -> $b failed ($i): $($_.Exception.Message)";if($i -ge $n){return $false};Start-Sleep -Seconds 1}}}
function Ok{try{$h=(RT "$S\health\$($j.installKey).json")|ConvertFrom-Json}catch{return $false};if([int64]$h.at -le [int64]$j.startedAt){return $false};if($j.mode -eq 'swap' -and $h.version -ne $j.toVersion){return $false};$true}
function Bad($r){L "preflight failed: $r";Go $I;Fin 'failed' $r}
Put "$S\$T.ready" (NowMs)
L "helper started: mode=$($j.mode) pid=$($j.pid) install=$I"
$dl=(Get-Date).AddSeconds($to.waitPidSec)
while(Old){if((Get-Date) -gt $dl){Fin 'aborted' 'ClaudeUI did not quit'};Start-Sleep -Milliseconds 200}
L "process $($j.pid) exited"
WaitGone $I $to.lockWaitSec
$left=Under $I
if($left.Count){
L "stopping: $($left.ProcessId -join ',')"
$left|%{Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
WaitGone $I $to.killWaitSec
$left=Under $I
if($left.Count){$n=(@($left|%{Split-Path -Leaf $_.ExecutablePath})|Select-Object -Unique) -join ', ';Go $I;Fin 'aborted' "files in use: $n"}}
if($j.mode -eq 'swap'){
$G=$j.stagedPath
if(-not (MOk $I)){Bad 'the install no longer carries a ClaudeUI marker'}
if(-not (Test-Path -LiteralPath $G -PathType Container)){Bad 'the staged build is missing'}
if(-not (MOk $G)){Bad 'the staged build carries no ClaudeUI marker'}
if(Test-Path -LiteralPath $j.backupPath){Bad 'the backup path already exists'}
if(Test-Path -LiteralPath $j.failedPath){Bad 'the failed-build path already exists'}
if(-not (MoveDir $G "$G.probe" 1)){Bad 'the staged build cannot be renamed'}
if(-not (MoveDir "$G.probe" $G 3)){Bad 'the staged build could not be renamed back'}
if(-not (MoveDir $I $j.backupPath 10)){Bad 'the install could not be moved aside'}
if(-not (MoveDir $G $I 1)){
if(-not (Test-Path -LiteralPath $I) -and (MoveDir $j.backupPath $I 10)){Go $I;Fin 'failed' 'the staged build could not be moved into place'}
Go $j.backupPath;Fin 'failed' "the staged build could not be moved into place, $PB$($j.backupPath)"}
$swapAt=Get-Date;$script:Swapped=$true
L 'swapped'}
Go $I
$t0=Get-Date;$retried=$false
while($true){
if(Ok){if($j.mode -eq 'swap'){Fin 'updated'};Fin 'ok'}
$el=((Get-Date)-$t0).TotalSeconds
if(-not $retried -and $el -ge $to.launchCheckSec){$retried=$true;if(-not (Under $I).Count){L 'nothing runs from the install; launching once more';Go $I}}
if($el -ge $to.healthSec){break}
Start-Sleep -Milliseconds 500}
if($j.mode -ne 'swap'){Fin 'no-health' "ClaudeUI did not report healthy within $($to.healthSec) s"}
$NH="the new build did not report healthy within $($to.healthSec) s"
L "$NH; rolling back"
$new=@(Under $I|?{$_.CreationDate -ge $swapAt})
if($new.Count){L "stopping: $($new.ProcessId -join ',')";$new|%{Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue};$dl=(Get-Date).AddSeconds($to.killWaitSec);while(@($new|?{Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue}).Count -and (Get-Date) -lt $dl){Start-Sleep -Milliseconds 500}}
if(-not (MoveDir $I $j.failedPath 10)){L 'could not move the new build aside'}
if(-not (Test-Path -LiteralPath $I) -and (MoveDir $j.backupPath $I 10)){Go $I;Fin 'rolled-back' $NH}
Go $j.backupPath
Fin 'failed' "$NH, $PB$($j.backupPath)"`

/** Drop comment lines and indentation: PowerShell needs neither, the command line has a limit. */
export function compactPowerShell(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .join('\n')
}

export const POWERSHELL_HELPER = compactPowerShell(POWERSHELL_SOURCE)

/** The bound asserted on the encoded command (the OS command-line limit is 32 767). */
export const POWERSHELL_ENCODED_LIMIT = 30_000

/** `-EncodedCommand` takes base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export const RELAUNCH_JOB_ENV = 'CLAUDEUI_RELAUNCH_JOB'

export interface HelperCommand {
  file: string
  args: string[]
  /** Extra environment for the helper (Windows: the job path). */
  env: Record<string, string>
  /** Variables removed from the inherited environment (matched case-insensitively). */
  unsetEnv: string[]
}

/**
 * The helper's environment: the parent's, minus `unsetEnv` (Windows keys are
 * case-insensitive, so every spelling goes), plus `env`.
 */
export function helperEnv(
  base: NodeJS.ProcessEnv,
  command: Pick<HelperCommand, 'env' | 'unsetEnv'>
): Record<string, string> {
  const drop = new Set(command.unsetEnv.map((k) => k.toLowerCase()))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base))
    if (v !== undefined && !drop.has(k.toLowerCase())) out[k] = v
  return { ...out, ...command.env }
}

/** The helper's command for a platform; the job path is the only variable part. */
export function helperCommand(
  platform: 'darwin' | 'win32' | 'linux',
  files: { json: string; sh: string },
  systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows'
): HelperCommand {
  if (platform === 'win32') {
    return {
      file: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encodePowerShell(POWERSHELL_HELPER)
      ],
      env: { [RELAUNCH_JOB_ENV]: files.json },
      // A module path from the parent (a PowerShell 7 session, a dev shell) must
      // not decide which modules Windows PowerShell autoloads for the helper.
      unsetEnv: ['PSModulePath']
    }
  }
  // `-p` (privileged): bash reads no BASH_ENV / ENV, honours no SHELLOPTS and
  // imports no functions from the environment, so nothing inherited runs first.
  return {
    file: '/bin/bash',
    args: ['-p', '-c', BASH_HELPER, 'claudeui-relaunch', files.sh],
    env: {},
    unsetEnv: []
  }
}
