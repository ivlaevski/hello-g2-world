import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type AppState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'confirm'
  | 'sending'
  | 'response'
  | 'error'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state: AppState = 'idle'
let audioChunks: Uint8Array[] = []
let transcript = ''
let geminiResponse = ''
let errorMsg = ''

// ---------------------------------------------------------------------------
// Config — served by the Vite dev-server middleware (see vite.config.ts)
// ---------------------------------------------------------------------------
async function getConfig(): Promise<{ apiKey: string; model: string }> {
  try {
    const res = await fetch('/api/config')
    const cfg = await res.json()
    return { apiKey: cfg.apiKey || '', model: cfg.model || 'gemini-2.0-flash' }
  } catch {
    return { apiKey: '', model: 'gemini-2.0-flash' }
  }
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------
function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

function pcmToWav(pcm: Uint8Array): Uint8Array {
  const sr = 16000, ch = 1, bps = 16
  const byteRate = sr * ch * (bps / 8)
  const blockAlign = ch * (bps / 8)
  const buf = new ArrayBuffer(44 + pcm.length)
  const v = new DataView(buf)

  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }

  w(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, ch, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, byteRate, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, bps, true)
  w(36, 'data')
  v.setUint32(40, pcm.length, true)

  const out = new Uint8Array(buf)
  out.set(pcm, 44)
  return out
}

/** Convert Uint8Array → base64, chunked to avoid call-stack overflow. */
function uint8ToBase64(data: Uint8Array): string {
  let bin = ''
  const step = 8192
  for (let i = 0; i < data.length; i += step) {
    const slice = data.subarray(i, Math.min(i + step, data.length))
    bin += String.fromCharCode.apply(null, Array.from(slice))
  }
  return btoa(bin)
}

// ---------------------------------------------------------------------------
// Gemini API (Google AI Studio)
// ---------------------------------------------------------------------------
type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }

async function callGemini(
  apiKey: string,
  model: string,
  parts: GeminiPart[],
  systemInstruction?: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const body: Record<string, unknown> = {
    contents: [{ parts }],
  }
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] }
  }

  const res = await fetch(`${url}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Gemini ${res.status}: ${txt.slice(0, 120)}`)
  }

  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

async function transcribeAudio(wav: Uint8Array, apiKey: string, model: string): Promise<string> {
  return callGemini(apiKey, model, [
    { text: 'Transcribe this audio exactly. Return only the transcription, nothing else.' },
    { inline_data: { mime_type: 'audio/wav', data: uint8ToBase64(wav) } },
  ])
}

async function askGemini(question: string, apiKey: string, model: string): Promise<string> {
  return callGemini(
    apiKey,
    model,
    [{ text: question }],
    'You are a helpful assistant. Keep responses concise — under 400 characters — as they are displayed on smart glasses with a tiny screen.',
  )
}

// ---------------------------------------------------------------------------
// Bridge & display helpers
// ---------------------------------------------------------------------------
const bridge = await waitForEvenAppBridge()
const userInfo = await bridge.getUserInfo()
const userName = userInfo?.name || 'there'

async function show(content: string) {
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: 1,
    containerName: 'main',
    content,
    contentOffset: 0,
    contentLength: 0,
  }))
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
async function transition(next: AppState) {
  state = next

  switch (state) {
    case 'idle':
      audioChunks = []
      transcript = ''
      geminiResponse = ''
      await show(`Hello, ${userName}!\n\nTap to record\nDouble-tap to exit`)
      break

    case 'recording':
      audioChunks = []
      await bridge.audioControl(true)
      await show('● Recording...\n\nTap to stop')
      break

    case 'transcribing': {
      await bridge.audioControl(false)
      await show('Transcribing...')
      try {
        const cfg = await getConfig()
        if (!cfg.apiKey) throw new Error('No API key — set it in the browser')
        const pcm = mergeChunks(audioChunks)
        if (pcm.length < 16_000) throw new Error('Too short — hold longer')
        const wav = pcmToWav(pcm)
        transcript = await transcribeAudio(wav, cfg.apiKey, cfg.model)
        if (!transcript.trim()) throw new Error('No speech detected')
        await transition('confirm')
      } catch (e: unknown) {
        errorMsg = e instanceof Error ? e.message : 'Transcription failed'
        await transition('error')
      }
      break
    }

    case 'confirm':
      await show(`"${transcript}"\n\nTap: ask Gemini\nSwipe ↓: cancel`)
      break

    case 'sending': {
      await show('Thinking...')
      try {
        const cfg = await getConfig()
        geminiResponse = await askGemini(transcript, cfg.apiKey, cfg.model)
        if (!geminiResponse.trim()) throw new Error('Empty response')
        await transition('response')
      } catch (e: unknown) {
        errorMsg = e instanceof Error ? e.message : 'Gemini error'
        await transition('error')
      }
      break
    }

    case 'response': {
      const text = geminiResponse.length > 450
        ? geminiResponse.slice(0, 447) + '...'
        : geminiResponse
      await show(`${text}\n\nTap for new message`)
      break
    }

    case 'error':
      await show(`Error: ${errorMsg}\n\nTap to retry`)
      break
  }
}

// ---------------------------------------------------------------------------
// Create the initial glasses page
// ---------------------------------------------------------------------------
const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 8,
  containerID: 1,
  containerName: 'main',
  content: `Hello, ${userName}!\n\nTap to record\nDouble-tap to exit`,
  isEventCapture: 1,
})

const startResult = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
  }),
)
console.log('Page created:', startResult === 0 ? 'success' : `failed (${startResult})`)

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------
const unsubscribe = bridge.onEvenHubEvent(async (event) => {
  // ---- Audio data (high-frequency during recording) ----
  if (event.audioEvent?.audioPcm) {
    if (state === 'recording') {
      audioChunks.push(new Uint8Array(event.audioEvent.audioPcm))
    }
    return
  }

  // ---- Scroll gestures on the text container ----
  if (event.textEvent) {
    const t = event.textEvent.eventType ?? 0
    if (t === 2 && state === 'confirm') {
      await transition('idle') // swipe down → cancel
    }
    return
  }

  // ---- System / tap events ----
  if (event.sysEvent) {
    const t = event.sysEvent.eventType ?? 0

    // Double-tap → exit
    if (t === 3) {
      await bridge.audioControl(false)
      bridge.shutDownPageContainer(1)
      return
    }

    // Lifecycle cleanup
    if (t === 6 || t === 7) {
      await bridge.audioControl(false)
      unsubscribe()
      return
    }

    // Single tap → state-dependent action
    if (t === 0) {
      switch (state) {
        case 'idle':      await transition('recording');    break
        case 'recording': await transition('transcribing'); break
        case 'confirm':   await transition('sending');      break
        case 'response':  // fall through
        case 'error':     await transition('idle');          break
      }
    }
  }
})

// Safety net — stop hardware on page unload
window.addEventListener('beforeunload', () => {
  bridge.audioControl(false)
  unsubscribe()
})
