/**
 * Settings › Voice input › Microphone — the picker and the test meter.
 *
 * PER CLIENT: the choice lives in this renderer's `localStorage`
 * (`lib/voice/mic-preference.ts`), never in the synced settings — a phone and the
 * Mac have different microphones. Hence the "this device" badge.
 *
 * The test meter runs its OWN `BrowserVoiceCapture` whose `sendAudio` throws the
 * audio away: it never touches the voice controller or the transport, so nothing
 * is recorded or sent anywhere, and it works on an engine with no voice server.
 * It stops on Stop, on unmount and when the window loses focus.
 *
 * Desktop: a select beside the label (mockup 9ba790b8). Phone: a list of rows
 * with a check (mockup 1b412724). Both follow `devicechange` while open.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SettingRow, SelectField, Button } from './settings-controls'
import {
  BrowserVoiceCapture,
  detectCaptureEnv,
  micDeniedMessage,
  noSignalMessage,
  type CaptureEnv
} from '../../lib/voice/browser-voice-capture'
import {
  audioInputs,
  findPreferred,
  realInputs,
  systemDefaultLabel,
  type MicDevice,
  type MicPreference
} from '../../lib/voice/mic-devices'
import {
  onMicPreferenceChange,
  readMicPreference,
  writeMicPreference
} from '../../lib/voice/mic-preference'

export const MIC_TEST_IDLE_TEXT = 'Speak to see the level. Nothing is recorded or sent.'
export const MIC_ALLOW_LIST_TEXT = 'Allow microphone access to list devices'
const DEFAULT_VALUE = 'default'
const MISSING_VALUE = '__not-connected__'
/** Above this level the meter says it hears you (the main process's signal floor). */
const HEARD_LEVEL = 0.01

export function notConnectedText(defaultLabel: string): string {
  return `Not connected now — using ${defaultLabel || 'the system default'}`
}

/** The device list, refreshed on every `devicechange`. */
function useAudioInputs(env: CaptureEnv): {
  inputs: MicDevice[]
  refresh: () => Promise<void>
} {
  const [inputs, setInputs] = useState<MicDevice[]>([])
  const refresh = useCallback(async () => {
    const md = env.mediaDevices
    if (!md?.enumerateDevices) return
    try {
      setInputs(audioInputs(await md.enumerateDevices()))
    } catch {
      setInputs([])
    }
  }, [env])
  useEffect(() => {
    void refresh()
    const md = env.mediaDevices
    const onChange = (): void => void refresh()
    md?.addEventListener?.('devicechange', onChange)
    return () => md?.removeEventListener?.('devicechange', onChange)
  }, [env, refresh])
  return { inputs, refresh }
}

function useMicPreference(): MicPreference | null {
  const [preference, setPreference] = useState<MicPreference | null>(() => readMicPreference())
  useEffect(() => onMicPreferenceChange(setPreference), [])
  return preference
}

type TestStatus =
  | { kind: 'idle' }
  | { kind: 'listening' }
  | { kind: 'heard'; label: string | null }
  | { kind: 'silent'; label: string | null }
  | { kind: 'error'; message: string }

/** The local test capture: level + status, never the transport. */
function useMicTest(env: CaptureEnv): {
  testing: boolean
  level: number
  status: TestStatus
  start: () => Promise<void>
  stop: () => void
} {
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const [status, setStatus] = useState<TestStatus>({ kind: 'idle' })
  const captureRef = useRef<BrowserVoiceCapture | null>(null)

  const stop = useCallback((): void => {
    const capture = captureRef.current
    captureRef.current = null
    if (capture) void capture.stop()
    setTesting(false)
    setLevel(0)
    setStatus((s) => (s.kind === 'error' ? s : { kind: 'idle' }))
  }, [])

  const start = useCallback(async (): Promise<void> => {
    if (captureRef.current) return
    let capture: BrowserVoiceCapture | null = null
    capture = new BrowserVoiceCapture({
      // The test meter's whole point: the audio goes nowhere.
      sendAudio: () => {},
      env,
      preference: readMicPreference,
      deniedMessage: micDeniedMessage(window.api?.platform),
      onLevel: (value) => {
        if (captureRef.current !== capture) return
        setLevel(value)
        if (value > HEARD_LEVEL) {
          setStatus((s) =>
            s.kind === 'silent' || s.kind === 'error'
              ? s
              : { kind: 'heard', label: capture!.currentTrackLabel() }
          )
        }
      },
      onSilence: ({ silent, trackLabel }) => {
        if (captureRef.current !== capture) return
        setStatus(
          silent
            ? { kind: 'silent', label: trackLabel }
            : { kind: 'heard', label: capture!.currentTrackLabel() }
        )
      },
      onSwitch: (label) => {
        if (captureRef.current !== capture) return
        setStatus((s) => (s.kind === 'heard' ? { kind: 'heard', label } : s))
      },
      onFault: (fault) => {
        if (captureRef.current !== capture) return
        if (fault.ended) {
          stop()
          setStatus({ kind: 'error', message: fault.message })
        }
      }
    })
    captureRef.current = capture
    setTesting(true)
    setLevel(0)
    setStatus({ kind: 'listening' })
    try {
      await capture.start()
      // Armed at once so blocks are dropped by the no-op sink, not queued.
      capture.arm()
    } catch (err) {
      if (captureRef.current === capture) captureRef.current = null
      setTesting(false)
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [env, stop])

  // Stop on unmount and when the window loses focus: a forgotten test must not
  // keep a microphone open behind the user's back.
  useEffect(() => {
    const onBlur = (): void => {
      if (captureRef.current) stop()
    }
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      const capture = captureRef.current
      captureRef.current = null
      if (capture) void capture.stop()
    }
  }, [stop])

  return { testing, level, status, start, stop }
}

export function MicrophoneSetting({
  enabled,
  env: envOverride
}: {
  /** The voice setting is on; off dims the row like the language picker. */
  enabled: boolean
  /** Test seam: the capture environment (fake `mediaDevices`). */
  env?: CaptureEnv
}): React.JSX.Element {
  const isMobile = useIsMobile()
  const env = useMemo(() => envOverride ?? detectCaptureEnv(), [envOverride])
  const { inputs, refresh } = useAudioInputs(env)
  const preference = useMicPreference()
  const test = useMicTest(env)
  const [accessError, setAccessError] = useState<string | null>(null)

  const devices = realInputs(inputs)
  const defaultLabel = systemDefaultLabel(inputs)
  const preferred = findPreferred(inputs, preference)
  const missing = preference !== null && preferred === null
  // Without permission the browser lists inputs with no names (or none at all).
  const labelsHidden = inputs.length === 0 || inputs.every((d) => !d.label)

  const choose = (value: string): void => {
    if (value === MISSING_VALUE) return
    const device = devices.find((d) => d.deviceId === value)
    writeMicPreference(device ? { deviceId: device.deviceId, label: device.label } : null)
    // A running test follows the choice.
    if (test.testing) {
      test.stop()
      void test.start()
    }
  }

  const allowAccess = async (): Promise<void> => {
    setAccessError(null)
    try {
      // User-initiated only: opened to unlock the names, closed at once.
      const stream = await env.mediaDevices!.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      await refresh()
    } catch (err) {
      const name = (err as { name?: string } | null)?.name
      setAccessError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? micDeniedMessage(window.api?.platform)
          : err instanceof Error
            ? err.message
            : String(err)
      )
    }
  }

  const value = preferred ? preferred.deviceId : missing ? MISSING_VALUE : DEFAULT_VALUE
  const defaultText = defaultLabel ? `System default — ${defaultLabel}` : 'System default'
  const deviceLabel = (d: MicDevice, i: number): string => d.label || `Microphone ${i + 1}`

  const badge = (
    <span
      data-testid="MicrophoneSetting.badge"
      className="shrink-0 text-[10px] leading-4 px-1.5 rounded bg-bg-tertiary text-text-secondary"
    >
      this device
    </span>
  )

  const notConnected = missing ? (
    <div
      data-testid="MicrophoneSetting.notConnected"
      className="mt-2 text-[12px] leading-4 text-warning flex items-center gap-1.5"
    >
      <span aria-hidden className="w-1.5 h-1.5 shrink-0 rounded-full bg-warning" />
      {notConnectedText(defaultLabel)}
    </div>
  ) : null

  const allow = labelsHidden ? (
    <div className="mt-2 flex flex-col gap-1">
      <Button
        variant="link"
        testid="MicrophoneSetting.allowAccess"
        disabled={!enabled}
        onClick={() => void allowAccess()}
      >
        {MIC_ALLOW_LIST_TEXT}
      </Button>
      {accessError && (
        <span
          data-testid="MicrophoneSetting.accessError"
          className="text-[12px] leading-4 text-warning"
        >
          {accessError}
        </span>
      )}
    </div>
  ) : null

  const picker = isMobile ? (
    <div
      role="radiogroup"
      aria-label="Microphone"
      className="mt-2 rounded-lg border border-border divide-y divide-border/55 overflow-hidden"
    >
      {[
        { value: DEFAULT_VALUE, label: defaultText, disabled: false },
        ...devices.map((d, i) => ({
          value: d.deviceId,
          label: deviceLabel(d, i),
          disabled: false
        })),
        ...(missing
          ? [
              {
                value: MISSING_VALUE,
                label: `${preference!.label} · not connected`,
                disabled: true
              }
            ]
          : [])
      ].map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          data-testid="MicrophoneSetting.option"
          data-id={opt.value}
          disabled={!enabled || opt.disabled}
          onClick={() => choose(opt.value)}
          className={`w-full min-h-[44px] px-3 py-2.5 flex items-center justify-between gap-3 text-left text-[13px] ${
            opt.disabled ? 'text-text-muted italic' : 'text-text-primary'
          }`}
        >
          <span className="min-w-0 truncate">{opt.label}</span>
          {opt.value === value && !opt.disabled && (
            <span aria-hidden className="text-accent">
              {'✓'}
            </span>
          )}
        </button>
      ))}
    </div>
  ) : (
    <SelectField
      testid="MicrophoneSetting.select"
      width="w-72"
      value={value}
      disabled={!enabled}
      onChange={choose}
      options={[
        {
          value: DEFAULT_VALUE,
          label: defaultText,
          trailing: value === DEFAULT_VALUE ? <Check /> : undefined
        },
        ...devices.map((d, i) => ({
          value: d.deviceId,
          label: deviceLabel(d, i),
          trailing: value === d.deviceId ? <Check /> : undefined
        })),
        ...(missing
          ? [
              {
                value: MISSING_VALUE,
                label: `${preference!.label} · not connected`,
                disabled: true
              }
            ]
          : [])
      ]}
    />
  )

  const meter = (
    <div
      data-testid="MicrophoneSetting.meter"
      className={`rounded-lg bg-bg-primary/40 border border-border px-3.5 py-3 ${
        isMobile ? 'mt-4' : 'mt-3'
      }`}
    >
      <div className="flex items-center gap-3">
        <Button
          variant="tinted"
          testid="MicrophoneSetting.test"
          disabled={!enabled && !test.testing}
          onClick={() => (test.testing ? test.stop() : void test.start())}
        >
          {test.testing ? 'Stop' : 'Test mic'}
        </Button>
        <div className="flex-1 h-2 rounded-full bg-bg-tertiary overflow-hidden">
          <div
            data-testid="MicrophoneSetting.level"
            className="h-full bg-success transition-[width] duration-75 motion-reduce:transition-none"
            style={{ width: `${Math.round(Math.min(1, test.level) * 100)}%` }}
          />
        </div>
      </div>
      <MeterStatus status={test.status} />
    </div>
  )

  if (isMobile) {
    return (
      <div data-testid="MicrophoneSetting" className={`px-3.5 py-3 ${enabled ? '' : 'opacity-50'}`}>
        <div className="flex items-center gap-2 text-[13px] leading-[18px] text-text-primary">
          Microphone {badge}
        </div>
        {picker}
        <div className="mt-2 text-[12px] leading-4 text-text-secondary">
          Used whenever it&apos;s connected; otherwise the system default.
        </div>
        {notConnected}
        {allow}
        {meter}
      </div>
    )
  }

  return (
    <div data-testid="MicrophoneSetting">
      <SettingRow
        testid="MicrophoneSetting.row"
        label="Microphone"
        labelBadge={badge}
        description="A chosen microphone is used whenever it's connected; otherwise the system default is used, and recording switches over if it changes mid-press. Saved on this device only."
        dimmed={!enabled}
      >
        <div className="flex flex-col items-stretch w-72">
          {picker}
          {notConnected}
          {allow}
        </div>
      </SettingRow>
      <div className={`px-3.5 pb-3 ${enabled ? '' : 'opacity-50'}`}>{meter}</div>
    </div>
  )
}

function Check(): React.JSX.Element {
  return (
    <span aria-hidden className="text-accent">
      {'✓'}
    </span>
  )
}

function MeterStatus({ status }: { status: TestStatus }): React.JSX.Element {
  const warn = status.kind === 'silent' || status.kind === 'error'
  const text =
    status.kind === 'silent'
      ? noSignalMessage(status.label)
      : status.kind === 'error'
        ? status.message
        : status.kind === 'heard'
          ? null
          : MIC_TEST_IDLE_TEXT
  return (
    <div
      data-testid="MicrophoneSetting.status"
      data-kind={status.kind}
      className={`mt-1.5 text-[12px] leading-4 ${warn ? 'text-warning' : 'text-text-secondary'}`}
    >
      {status.kind === 'heard' ? (
        <>
          Hearing you on{' '}
          <span className="text-text-primary font-medium">{status.label || 'the microphone'}</span>.
        </>
      ) : (
        text
      )}
    </div>
  )
}
