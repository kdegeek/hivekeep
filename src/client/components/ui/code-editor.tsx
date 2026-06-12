import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
// Prec/Extension come via the react-codemirror re-export: @codemirror/state is
// only an override (isolated install), not directly importable from app code.
import CodeMirror, { Prec, type Extension } from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { StreamLanguage, LanguageDescription } from '@codemirror/language'
import { languages as languageData } from '@codemirror/language-data'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { useTheme } from 'next-themes'
import { cn } from '@/client/lib/utils'
import { buildThemeExtension } from '@/client/components/ui/codemirror-theme'

export type CodeEditorLanguage =
  | 'json'
  | 'ts'
  | 'tsx'
  | 'js'
  | 'jsx'
  | 'python'
  | 'bash'
  | 'sh'
  | 'plain'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  /**
   * Syntax highlighting hint. 'json' and JS/TS family get full language
   * support; everything else (python/bash/sh/plain) falls back to plain text
   * with line numbers — still far better than a bare <textarea>.
   */
  language?: CodeEditorLanguage | string
  /**
   * Alternative to `language`: resolve the language from a filename via
   * @codemirror/language-data (lazy-loaded, ~150 languages — same registry
   * MarkdownEditor uses for code blocks). Takes precedence over `language`.
   */
  filename?: string
  height?: string
  readOnly?: boolean
  /** Soft-wrap long lines. Default ON for readability in a narrow modal. */
  lineWrapping?: boolean
  /** Extra CodeMirror extensions appended after the built-in ones. */
  extensions?: Extension[]
  /** Bound to Mod-S inside the editor (browser save dialog suppressed). */
  onSave?: () => void
  className?: string
}

/** Resolve the optional CodeMirror language extension for a given language id. */
function languageExtension(language?: string) {
  switch (language) {
    case 'json':
      return json()
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return javascript({ jsx: true, typescript: true })
    case 'python':
      return python()
    case 'bash':
    case 'sh':
      return StreamLanguage.define(shell)
    // plain / unknown → plain text (line numbers only)
    default:
      return null
  }
}

/**
 * Generic code editor wrapping CodeMirror, themed via the shared design-token
 * theme builder (matches MarkdownEditor look & feel: focus ring wrapper,
 * palette-aware colors, dark/light via next-themes).
 */
export function CodeEditor({
  value,
  onChange,
  language,
  filename,
  height = '220px',
  readOnly = false,
  lineWrapping = true,
  extensions: extraExtensions,
  onSave,
  className,
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  // Filename-based language: matched against the lazy language-data registry.
  const [fileLanguage, setFileLanguage] = useState<Extension | null>(null)
  useEffect(() => {
    if (!filename) {
      setFileLanguage(null)
      return
    }
    let cancelled = false
    const description = LanguageDescription.matchFilename(languageData, filename)
    if (!description) {
      setFileLanguage(null)
      return
    }
    description.load().then(
      (ext) => {
        if (!cancelled) setFileLanguage(ext)
      },
      () => {
        if (!cancelled) setFileLanguage(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [filename])

  // Keep the latest onSave without rebuilding the keymap extension each render.
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const extensions = useMemo(() => {
    const exts: Extension[] = []
    const lang = filename ? fileLanguage : languageExtension(language)
    if (lang) exts.push(lang)
    if (lineWrapping) exts.push(EditorView.lineWrapping)
    if (onSaveRef.current !== undefined || onSave !== undefined) {
      exts.push(
        Prec.high(
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                onSaveRef.current?.()
                return true
              },
            },
          ]),
        ),
      )
    }
    if (extraExtensions) exts.push(...extraExtensions)
    return exts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, filename, fileLanguage, lineWrapping, extraExtensions, onSave !== undefined])

  const theme = useMemo(() => buildThemeExtension(isDark), [isDark])

  const handleChange = useCallback((val: string) => {
    onChange(val)
  }, [onChange])

  return (
    <div className={cn(
      'min-w-0 max-w-full overflow-hidden rounded-md border border-input transition-[color,box-shadow]',
      '[&:has(.cm-focused)]:border-ring [&:has(.cm-focused)]:ring-[3px] [&:has(.cm-focused)]:ring-ring/50',
      className,
    )}>
      <CodeMirror
        value={value}
        onChange={handleChange}
        height={height}
        theme={theme}
        extensions={extensions}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          bracketMatching: true,
          closeBrackets: false,
          autocompletion: false,
          crosshairCursor: false,
          rectangularSelection: false,
          highlightSelectionMatches: false,
          searchKeymap: false,
          lintKeymap: false,
          completionKeymap: false,
          foldKeymap: false,
        }}
      />
    </div>
  )
}
