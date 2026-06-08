import { useMemo, useState } from 'react'

/**
 * Client-side install-command generator for the /install page.
 *
 * It owns no network calls, it just turns a few choices into the exact
 * `docker run` / `docker-compose.yml` + `.env` / `install.sh` invocation,
 * plus a reverse-proxy snippet for the "public domain" case.
 *
 * Canonical facts it encodes (keep in sync with docker/ + install.sh):
 *  - image:        ghcr.io/marlburrow/hivekeep
 *  - data volume:  /app/data  (MUST persist: holds the auto-generated
 *                  encryption key; lose it and every vault secret is gone)
 *  - app port:     3000 inside the container; install.sh default 3000
 *  - install.sh:   reads HIVEKEEP_PORT / HIVEKEEP_PUBLIC_URL
 */

const IMAGE = 'ghcr.io/marlburrow/hivekeep'
const INSTALL_SH = 'https://raw.githubusercontent.com/MarlBurroW/hivekeep/main/install.sh'

type UseCase = 'try' | 'permanent' | 'server'
type Method = 'docker' | 'native'
type Proxy = 'caddy' | 'nginx' | 'own'
type DockerTab = 'run' | 'compose'

const USE_CASES: { id: UseCase; label: string; hint: string }[] = [
  { id: 'try', label: 'Just trying it out', hint: 'Run it on this machine, localhost only. Zero config.' },
  { id: 'permanent', label: 'Permanent on this machine', hint: 'A lasting home for your agents. Optional access from other devices.' },
  { id: 'server', label: 'Server with a domain', hint: 'Public, HTTPS, reachable at your own domain.' },
]

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={`cfg-copy${done ? ' done' : ''}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          /* clipboard blocked: no-op */
        }
      }}
      aria-label="Copy to clipboard"
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function CodeBlock({ title, code, lang }: { title?: string; code: string; lang?: string }) {
  return (
    <div className="cfg-block">
      {title && (
        <div className="cfg-block-head">
          <span className="cfg-block-title">
            {title}
            {lang && <span className="cfg-lang">{lang}</span>}
          </span>
          <CopyButton text={code} />
        </div>
      )}
      <pre className="cfg-code">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function randomKey() {
  // 32 bytes -> 64 hex chars, matching ENCRYPTION_KEY format.
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export default function InstallConfigurator() {
  const [useCase, setUseCase] = useState<UseCase>('try')
  const [method, setMethod] = useState<Method>('native')
  const [port, setPort] = useState('3000')
  const [lanAccess, setLanAccess] = useState(false)
  const [host, setHost] = useState('')
  const [proxy, setProxy] = useState<Proxy>('caddy')
  const [setKey, setSetKey] = useState(false)
  const [key, setKey_] = useState('')
  const [dockerTab, setDockerTab] = useState<DockerTab>('run')

  // Picking a use case resets method + tab to that case's sensible default.
  // Native is the recommended default everywhere (it builds locally and needs
  // no published image); the server case leans on docker compose by convention,
  // but the method toggle stays available so anyone can switch.
  function pickUseCase(uc: UseCase) {
    setUseCase(uc)
    if (uc === 'try') {
      setMethod('native')
    } else if (uc === 'permanent') {
      setMethod('native')
    } else {
      setMethod('native')
      setDockerTab('compose')
    }
  }

  const isServer = useCase === 'server'
  const portN = port.trim() || '3000'

  // The public URL the user will actually reach the app at.
  const publicUrl = useMemo(() => {
    if (isServer) return `https://${host.trim() || 'hivekeep.example.com'}`
    if (useCase === 'permanent' && lanAccess) return `http://${host.trim() || '192.168.1.50'}:${portN}`
    return `http://localhost:${portN}`
  }, [isServer, useCase, lanAccess, host, portN])

  const isDefaultUrl = publicUrl === `http://localhost:${portN}`
  // Behind a reverse proxy we bind the port to loopback so the app isn't
  // exposed directly; otherwise bind normally.
  const loopbackBind = isServer
  const portMap = loopbackBind ? `127.0.0.1:${portN}:3000` : `${portN}:3000`

  const dockerRun = useMemo(() => {
    const parts = ['docker run -d', '--name hivekeep', `-p ${portMap}`, '-v hivekeep-data:/app/data']
    if (!isDefaultUrl) parts.push(`-e PUBLIC_URL=${publicUrl}`)
    if (setKey && key) parts.push(`-e ENCRYPTION_KEY=${key}`)
    parts.push(IMAGE)
    return parts.join(' \\\n  ')
  }, [portMap, isDefaultUrl, publicUrl, setKey, key])

  const composeYml = useMemo(
    () =>
      [
        'services:',
        '  hivekeep:',
        `    image: ${IMAGE}:latest`,
        '    container_name: hivekeep',
        '    restart: unless-stopped',
        '    ports:',
        `      - "${portMap}"`,
        '    volumes:',
        '      - hivekeep-data:/app/data',
        '    env_file: .env',
        'volumes:',
        '  hivekeep-data:',
      ].join('\n'),
    [portMap],
  )

  const envFile = useMemo(() => {
    const lines = [
      '# Public URL: used for invitation links, webhooks, OAuth callbacks, CORS.',
      `PUBLIC_URL=${publicUrl}`,
      '',
      '# Encryption key (AES-256-GCM, 64 hex chars). Auto-generated and stored',
      '# inside the data volume if you leave this unset. Setting it yourself lets',
      '# you back it up: losing it makes every vault secret unrecoverable.',
      setKey && key ? `ENCRYPTION_KEY=${key}` : '# ENCRYPTION_KEY=',
    ]
    return lines.join('\n')
  }, [publicUrl, setKey, key])

  const nativeCmd = useMemo(() => {
    const env: string[] = []
    if (portN !== '3000') env.push(`HIVEKEEP_PORT=${portN}`)
    if (!isDefaultUrl) env.push(`HIVEKEEP_PUBLIC_URL=${publicUrl}`)
    if (setKey && key) env.push(`ENCRYPTION_KEY=${key}`)
    if (env.length === 0) return `curl -fsSL ${INSTALL_SH} | bash`
    return `${env.join(' ')} \\\n  bash <(curl -fsSL ${INSTALL_SH})`
  }, [portN, isDefaultUrl, publicUrl, setKey, key])

  const caddyfile = useMemo(
    () => `${host.trim() || 'hivekeep.example.com'} {\n    reverse_proxy localhost:${portN}\n}`,
    [host, portN],
  )

  const nginxConf = useMemo(
    () =>
      [
        'server {',
        '    listen 80;',
        `    server_name ${host.trim() || 'hivekeep.example.com'};`,
        '',
        '    location / {',
        `        proxy_pass http://localhost:${portN};`,
        '        proxy_http_version 1.1;',
        '        proxy_set_header Host $host;',
        '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '        proxy_set_header X-Forwarded-Proto $scheme;',
        '        # SSE: stream events without buffering',
        '        proxy_set_header Connection \'\';',
        '        proxy_buffering off;',
        '    }',
        '}',
        '',
        `# Then add HTTPS:  sudo certbot --nginx -d ${host.trim() || 'hivekeep.example.com'}`,
      ].join('\n'),
    [host, portN],
  )

  return (
    <div className="cfg">
      {/* Step 1: use case */}
      <div className="cfg-step">
        <h3>1 · How will you use it?</h3>
        <div className="cfg-opts">
          {USE_CASES.map((uc) => (
            <button
              key={uc.id}
              type="button"
              className={`cfg-opt${useCase === uc.id ? ' sel' : ''}`}
              onClick={() => pickUseCase(uc.id)}
            >
              <span className="cfg-opt-label">{uc.label}</span>
              <span className="cfg-opt-hint">{uc.hint}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Step 2: settings */}
      <div className="cfg-step">
        <h3>2 · Settings</h3>
        <div className="cfg-fields">
          {/* method: native is recommended; Docker stays available with a caveat */}
          <div className="cfg-field">
            <label>Method</label>
            <div className="cfg-seg">
              <button type="button" className={method === 'native' ? 'sel' : ''} onClick={() => setMethod('native')}>
                Native (recommended)
              </button>
              <button type="button" className={method === 'docker' ? 'sel' : ''} onClick={() => setMethod('docker')}>
                Docker
              </button>
            </div>
          </div>

          <div className="cfg-field">
            <label htmlFor="cfg-port">Port</label>
            <input
              id="cfg-port"
              type="text"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="3000"
            />
          </div>

          {useCase === 'permanent' && (
            <div className="cfg-field">
              <label>
                <input type="checkbox" checked={lanAccess} onChange={(e) => setLanAccess(e.target.checked)} /> Access from
                other devices on my network
              </label>
              {lanAccess && (
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="this machine's LAN IP, e.g. 192.168.1.50"
                />
              )}
            </div>
          )}

          {isServer && (
            <div className="cfg-field">
              <label htmlFor="cfg-domain">Your domain</label>
              <input
                id="cfg-domain"
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="hivekeep.example.com"
              />
            </div>
          )}

          {isServer && (
            <div className="cfg-field">
              <label>Reverse proxy (HTTPS)</label>
              <div className="cfg-seg">
                <button type="button" className={proxy === 'caddy' ? 'sel' : ''} onClick={() => setProxy('caddy')}>
                  Caddy
                </button>
                <button type="button" className={proxy === 'nginx' ? 'sel' : ''} onClick={() => setProxy('nginx')}>
                  nginx
                </button>
                <button type="button" className={proxy === 'own' ? 'sel' : ''} onClick={() => setProxy('own')}>
                  I have my own
                </button>
              </div>
            </div>
          )}

          {/* advanced: explicit encryption key */}
          <div className="cfg-field cfg-adv">
            <label>
              <input
                type="checkbox"
                checked={setKey}
                onChange={(e) => {
                  setSetKey(e.target.checked)
                  if (e.target.checked && !key) setKey_(randomKey())
                }}
              />{' '}
              Set a fixed encryption key (advanced: back it up)
            </label>
            {setKey && (
              <div className="cfg-keyrow">
                <input type="text" value={key} onChange={(e) => setKey_(e.target.value)} spellCheck={false} />
                <button type="button" className="cfg-mini" onClick={() => setKey_(randomKey())}>
                  Generate
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Step 3: output */}
      <div className="cfg-step">
        <h3>3 · Run it</h3>

        {method === 'docker' ? (
          <>
            {/* Honest caveat: the published image is not available yet. */}
            <div className="cfg-warn">
              <strong>Heads up: the published Docker image is not available yet.</strong>
              <span>
                These commands pull <code>{IMAGE}</code>, which is not public on the registry at the moment, so they will
                fail with <code>manifest unknown</code> or <code>denied</code>. Until it's published, use the{' '}
                <button type="button" className="cfg-inline-link" onClick={() => setMethod('native')}>
                  native install
                </button>{' '}
                (it builds locally and needs no image), or build the image yourself from a clone of the repo.
              </span>
            </div>
            <div className="cfg-tabs">
              <button type="button" className={dockerTab === 'run' ? 'sel' : ''} onClick={() => setDockerTab('run')}>
                docker run
              </button>
              <button type="button" className={dockerTab === 'compose' ? 'sel' : ''} onClick={() => setDockerTab('compose')}>
                docker compose
              </button>
            </div>
            {dockerTab === 'run' ? (
              <>
                <CodeBlock title="Run" lang="shell" code={dockerRun} />
                <p className="cfg-note cfg-keynote">
                  <strong>Keep your encryption key.</strong> The key is stored inside the <code>hivekeep-data</code>{' '}
                  volume. If you delete or recreate that volume without persisting the key (or pinning a fixed{' '}
                  <code>ENCRYPTION_KEY</code> with the advanced toggle above), every vault secret becomes unrecoverable.
                </p>
              </>
            ) : (
              <>
                <CodeBlock title="docker-compose.yml" lang="yaml" code={composeYml} />
                <CodeBlock title=".env" lang="env" code={envFile} />
                <CodeBlock title="Start" lang="shell" code="docker compose up -d" />
                <p className="cfg-note cfg-keynote">
                  <strong>Keep your encryption key.</strong> It lives in the <code>hivekeep-data</code> volume. Recreating
                  the volume without persisting the key (or setting a fixed <code>ENCRYPTION_KEY</code> in{' '}
                  <code>.env</code>) makes every stored secret unrecoverable.
                </p>
              </>
            )}
            {/* Recovery notes for the common non-dev Docker failures. */}
            <div className="cfg-recover">
              <span className="cfg-recover-head">If a command fails</span>
              <ul>
                <li>
                  <code>port is already allocated</code>: port {portN} is in use. Change the Port field above and copy
                  the new command.
                </li>
                <li>
                  <code>manifest unknown</code> / <code>denied</code>: the published image isn't available yet. Use the{' '}
                  <button type="button" className="cfg-inline-link" onClick={() => setMethod('native')}>
                    native install
                  </button>{' '}
                  instead, or build locally.
                </li>
                <li>
                  <code>Cannot connect to the Docker daemon</code>: Docker isn't running. Start Docker Desktop, or run{' '}
                  <code>sudo systemctl start docker</code> on Linux.
                </li>
              </ul>
            </div>
          </>
        ) : (
          <>
            <CodeBlock title="Install" lang="shell" code={nativeCmd} />
            <p className="cfg-note cfg-keynote">
              <strong>Your encryption key is handled for you.</strong> The installer auto-generates and saves it at{' '}
              <code>$DATA_DIR/.encryption-key</code> so your secrets survive restarts. Back up that file alongside your
              database. (Pin a fixed <code>ENCRYPTION_KEY</code> with the advanced toggle above if you'd rather manage it
              yourself.)
            </p>
            {/* Recovery notes for the common native failures. */}
            <div className="cfg-recover">
              <span className="cfg-recover-head">If the install fails</span>
              <ul>
                <li>
                  <code>port already in use</code> / <code>EADDRINUSE</code>: port {portN} is taken. Change the Port
                  field above and re-run.
                </li>
                <li>
                  <strong>Windows</strong>: the installer is Linux and macOS only. Run it inside <strong>WSL2</strong>,
                  or use Docker Desktop.
                </li>
                <li>
                  <strong>Download or clone hangs</strong>: make sure the machine can reach <code>github.com</code> and{' '}
                  <code>bun.sh</code> over HTTPS (a proxy may be blocking them).
                </li>
              </ul>
            </div>
          </>
        )}

        {/* reverse proxy snippet for the public-domain case */}
        {isServer && (
          <div className="cfg-proxy">
            {proxy === 'caddy' && (
              <>
                <p className="cfg-note">
                  Caddy handles HTTPS automatically (Let's Encrypt). Put this in your <code>Caddyfile</code> and run{' '}
                  <code>caddy run</code>.
                </p>
                <CodeBlock title="Caddyfile" code={caddyfile} />
              </>
            )}
            {proxy === 'nginx' && (
              <>
                <p className="cfg-note">An nginx server block proxying to Hivekeep, then certbot for HTTPS.</p>
                <CodeBlock title="/etc/nginx/sites-available/hivekeep" code={nginxConf} />
              </>
            )}
            {proxy === 'own' && (
              <p className="cfg-note">
                Point your reverse proxy at <code>http://localhost:{portN}</code>, make sure{' '}
                <code>PUBLIC_URL={publicUrl}</code> is set (it already is above), and disable response buffering on{' '}
                <code>/api/sse</code> so server-sent events stream through.
              </p>
            )}
          </div>
        )}

        <p className="cfg-foot">
          Open <code>{publicUrl}</code> in your browser. Queenie walks you through the rest (admin account, your first AI
          provider, your first agents). No config files to edit.
        </p>
      </div>
    </div>
  )
}
