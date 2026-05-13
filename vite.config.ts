import { defineConfig } from 'vite'
import { readFileSync, writeFileSync } from 'node:fs'

const CONFIG = 'config.local'

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG, 'utf-8')) }
  catch { return { apiKey: '' } }
}

export default defineConfig({
  plugins: [{
    name: 'config-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/config')) return next()

        if (req.method === 'POST') {
          let body = ''
          req.on('data', (c) => { body += c })
          req.on('end', () => {
            try {
              const data = { ...readConfig(), ...JSON.parse(body) }
              writeFileSync(CONFIG, JSON.stringify(data, null, 2))
              res.setHeader('Content-Type', 'application/json')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('Invalid JSON')
            }
          })
        } else {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(readConfig()))
        }
      })
    },
  }],
})
