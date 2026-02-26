import { useState, useRef, useCallback } from 'react'

interface NoiseState {
  ctx: AudioContext
  sources: (AudioBufferSourceNode | OscillatorNode)[]
  gain: GainNode
}

export function NoisyMusicButton(): React.JSX.Element {
  const [playing, setPlaying] = useState(false)
  const noiseRef = useRef<NoiseState | null>(null)

  const toggle = useCallback(() => {
    if (noiseRef.current) {
      // Stop
      noiseRef.current.sources.forEach((s) => s.stop())
      noiseRef.current.ctx.close()
      noiseRef.current = null
      setPlaying(false)
      return
    }

    // Start
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.gain.value = 0.15
    gain.connect(ctx.destination)

    const sources: (AudioBufferSourceNode | OscillatorNode)[] = []

    // White noise buffer (2 seconds, looping)
    const bufferSize = ctx.sampleRate * 2
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1
    }
    const noise = ctx.createBufferSource()
    noise.buffer = buffer
    noise.loop = true
    noise.connect(gain)
    noise.start()
    sources.push(noise)

    // Chaotic oscillators
    const freqs = [
      Math.random() * 400 + 100,
      Math.random() * 800 + 200,
      Math.random() * 1200 + 300
    ]
    const types: OscillatorType[] = ['sawtooth', 'square', 'triangle']
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = types[i]
      osc.frequency.value = freq
      osc.detune.value = Math.random() * 100 - 50
      const oscGain = ctx.createGain()
      oscGain.gain.value = 0.06
      osc.connect(oscGain)
      oscGain.connect(gain)
      osc.start()
      sources.push(osc)
    })

    noiseRef.current = { ctx, sources, gain }
    setPlaying(true)
  }, [])

  return (
    <button
      onClick={toggle}
      className={`fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full flex items-center justify-center text-xl shadow-lg transition-all cursor-pointer ${
        playing
          ? 'bg-red-500 hover:bg-red-600 text-white animate-pulse'
          : 'bg-bg-tertiary hover:bg-bg-quaternary text-text-secondary hover:text-text-primary'
      }`}
      title={playing ? 'Stop the noise' : 'Play noisy music'}
    >
      {playing ? '■' : '♪'}
    </button>
  )
}
