/**
 * Layer 1: which microphone a capture binds to — the whole policy as a table.
 */

import { describe, it, expect } from 'vitest'
import {
  audioInputs,
  findPreferred,
  resolveMic,
  systemDefault,
  systemDefaultLabel,
  trackMatchesTarget,
  type MicDevice
} from '../mic-devices'

const dev = (deviceId: string, label: string, groupId = `g-${deviceId}`): MicDevice => ({
  deviceId,
  label,
  groupId
})

// What Chromium on a Mac lists with AirPods connected and the built-in mic as default.
const MAC = dev('mac', 'MacBook Pro Microphone')
const AIRPODS = dev('pods', 'AirPods Pro')
const DEFAULT_MAC = dev('default', 'Default - MacBook Pro Microphone', MAC.groupId)
const CHROMIUM = [DEFAULT_MAC, MAC, AIRPODS]

describe('audioInputs', () => {
  it('keeps audio inputs only, and drops the synthetic `communications` entry', () => {
    expect(
      audioInputs([
        { kind: 'audioinput', deviceId: 'default', label: 'Default - Mic', groupId: 'g1' },
        { kind: 'audioinput', deviceId: 'communications', label: 'Comms - Mic', groupId: 'g1' },
        { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers', groupId: 'g2' },
        { kind: 'videoinput', deviceId: 'cam', label: 'Camera', groupId: 'g3' },
        { kind: 'audioinput', deviceId: 'mic', label: 'Mic', groupId: 'g1' }
      ])
    ).toEqual([dev('default', 'Default - Mic', 'g1'), dev('mic', 'Mic', 'g1')])
  })
})

describe('the system default', () => {
  it('is the real device sharing the `default` entry’s groupId (Chromium)', () => {
    expect(systemDefault(CHROMIUM)).toEqual(MAC)
    expect(systemDefaultLabel(CHROMIUM)).toBe('MacBook Pro Microphone')
  })

  it('is the first input where there is no `default` entry (Firefox, Safari)', () => {
    expect(systemDefault([AIRPODS, MAC])).toEqual(AIRPODS)
  })

  it('falls back to the entry itself, minus its prefix, when its twin is not listed', () => {
    const lonely = [dev('default', 'Default - Studio Mic', 'g-studio')]
    expect(systemDefaultLabel(lonely)).toBe('Studio Mic')
  })

  it('is nothing when nothing is connected', () => {
    expect(systemDefault([])).toBeNull()
    expect(systemDefaultLabel([])).toBe('')
  })
})

describe('resolveMic', () => {
  it.each([
    ['no preference → the system default', null, { kind: 'default', device: MAC }],
    [
      'preferred and connected → that device',
      { deviceId: 'pods', label: 'AirPods Pro' },
      { kind: 'preferred', device: AIRPODS }
    ],
    [
      'preferred, id ROTATED → found by its exact label',
      { deviceId: 'old-id', label: 'AirPods Pro' },
      { kind: 'preferred', device: AIRPODS }
    ],
    [
      'preferred and absent → the system default, flagged missing',
      { deviceId: 'sony', label: 'Sony WH-1000XM5' },
      { kind: 'default', device: MAC, preferredMissing: true }
    ],
    [
      'the synthetic `default` entry is never a preferred device',
      { deviceId: 'default', label: '' },
      { kind: 'default', device: MAC, preferredMissing: true }
    ]
  ] as const)('%s', (_name, preference, expected) => {
    expect(resolveMic(CHROMIUM, preference)).toMatchObject(expected)
  })

  it('a label match is EXACT — a near-miss name is a different device', () => {
    expect(findPreferred(CHROMIUM, { deviceId: 'x', label: 'AirPods' })).toBeNull()
  })

  it('the `communications` entry is ignored even when a preference names it', () => {
    const inputs = audioInputs([
      { kind: 'audioinput', deviceId: 'communications', label: 'Comms', groupId: 'g' },
      { kind: 'audioinput', deviceId: 'mic', label: 'Mic', groupId: 'g' }
    ])
    expect(resolveMic(inputs, { deviceId: 'communications', label: 'Comms' })).toMatchObject({
      kind: 'default',
      preferredMissing: true
    })
  })
})

describe('trackMatchesTarget — does the live track need to move?', () => {
  const onMac = { boundTo: 'default' as const, deviceId: 'mac', groupId: MAC.groupId }

  it('a default-bound track follows an OS default change (the `default` entry’s groupId)', () => {
    expect(trackMatchesTarget(resolveMic(CHROMIUM, null), onMac, CHROMIUM)).toBe(true)
    const moved = [dev('default', 'Default - AirPods Pro', AIRPODS.groupId), MAC, AIRPODS]
    expect(trackMatchesTarget(resolveMic(moved, null), onMac, moved)).toBe(false)
  })

  it('a preferred device connecting moves a default-bound track to it', () => {
    const target = resolveMic(CHROMIUM, { deviceId: 'pods', label: 'AirPods Pro' })
    expect(trackMatchesTarget(target, onMac, CHROMIUM)).toBe(false)
  })

  it('a track bound to the preferred device moves when it is gone', () => {
    const onPods = { boundTo: 'preferred' as const, deviceId: 'pods', groupId: AIRPODS.groupId }
    const target = resolveMic([DEFAULT_MAC, MAC], { deviceId: 'pods', label: 'AirPods Pro' })
    expect(trackMatchesTarget(target, onPods, [DEFAULT_MAC, MAC])).toBe(false)
  })

  it('without a `default` entry a default change is invisible — no switch', () => {
    expect(trackMatchesTarget(resolveMic([AIRPODS, MAC], null), onMac, [AIRPODS, MAC])).toBe(true)
  })
})
