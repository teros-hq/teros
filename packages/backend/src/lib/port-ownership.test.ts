/**
 * Port ownership audit — unit tests.
 *
 * Incident 2026-11-01 08:40: a restart left an orphan (non-pm2) process
 * listening on the backend port serving stale code, while backend-status
 * reported its pid as healthy. These tests pin the exact logic that must
 * catch that class of state: /proc parsing, inode→pid mapping, ppid-chain
 * descent (including the re-parented orphan signature), pm2 env markers,
 * the audit verdicts, and the kill-foreign guard rails (never kill the pm2
 * tree, never kill ourselves).
 */
import { describe, expect, it } from 'bun:test'
import {
  auditPortOwnership,
  descendsFrom,
  findPidsBySocketInodes,
  hasPm2EnvFor,
  inspectProcess,
  killForeignPortHolders,
  parseProcNetTcp,
  currentPm2WrapperPid,
  type PortOwnerProcess,
} from './port-ownership'

// ─── /proc/net/tcp parsing ───────────────────────────────────────────────────

describe('parseProcNetTcp', () => {
  it('extracts LISTEN sockets (state 0A) with port and inode', () => {
    // 10001 = 0x2711, 3000 = 0x0BB8
    const content = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:2711 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 406236722 1 000000003b47dde9 100 0 0 10 0',
      '   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22253 2 00000000dcdae287 100 0 0 10 0',
    ].join('\n')
    const rows = parseProcNetTcp(content)
    expect(rows).toEqual([
      { localPort: 10001, inode: 406236722 },
      { localPort: 3000, inode: 22253 },
    ])
  })

  it('ignores non-LISTEN states (01 = ESTABLISHED) and junk lines', () => {
    const content = [
      'header',
      '   0: 0100007F:2711 0100007F:2711 01 00000000:00000000 00:00000000 00000000     0        0 999 1 ...',
      '   1: 00000000:2711 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 555 1 ...',
      'garbage',
    ].join('\n')
    const rows = parseProcNetTcp(content)
    expect(rows).toEqual([{ localPort: 10001, inode: 555 }])
  })

  it('returns empty for empty content', () => {
    expect(parseProcNetTcp('')).toEqual([])
    expect(parseProcNetTcp('header only\n')).toEqual([])
  })
})

// ─── inode → pid mapping ────────────────────────────────────────────────────

describe('findPidsBySocketInodes', () => {
  it('maps socket inodes to the pids holding them', () => {
    // Fake /proc: fd dir entries are fd NUMBERS; readLink resolves them.
    const listProcDir = () => ['101', '202', 'notapid']
    const readDirNames = (p: string) => {
      if (p === '/proc/101/fd') return ['0', '1', '51', '52']
      if (p === '/proc/202/fd') return ['3']
      throw new Error('unreadable')
    }
    const readLink = (p: string) => {
      if (p === '/proc/101/fd/51') return 'socket:[777]'
      if (p === '/proc/101/fd/52') return 'socket:[999]'
      if (p === '/proc/202/fd/3') return 'socket:[888]'
      return '/dev/null'
    }
    const pids = findPidsBySocketInodes(new Set([777, 888]), listProcDir, readDirNames, readLink)
    expect(pids).toEqual([101, 202])
  })

  it('skips processes whose fd dir is unreadable (vanished mid-scan)', () => {
    const listProcDir = () => ['101', '202']
    const readDirNames = (p: string) => {
      if (p === '/proc/101/fd') throw new Error('gone')
      return ['3']
    }
    const readLink = (p: string) => (p === '/proc/202/fd/3' ? 'socket:[888]' : '/dev/null')
    const pids = findPidsBySocketInodes(new Set([888]), listProcDir, readDirNames, readLink)
    expect(pids).toEqual([202])
  })

  it('returns empty for an empty inode set', () => {
    expect(findPidsBySocketInodes(new Set(), () => ['1'], () => [], () => '')).toEqual([])
  })
})

describe('findPidsBySocketInodes — incident 2026-11-01 regressions', () => {
  it('a fd that disappears mid-scan (ENOENT) skips ONLY that fd, not the whole pid — the real bug', () => {
    // Reproduces the false negative: the backend holds the LISTEN socket on
    // fd 52, but an ephemeral fd (155) closes between readdir and readlink.
    // The old code aborted the whole pid on that ENOENT -> listenerPids: [].
    const listProcDir = () => ['12054']
    const readDirNames = (p: string) => {
      if (p === '/proc/12054/fd') return ['0', '1', '155', '52']
      throw new Error('unexpected dir ' + p)
    }
    const readLink = (p: string) => {
      if (p === '/proc/12054/fd/155') throw new Error("ENOENT: no such file or directory, readlink '/proc/12054/fd/155'")
      if (p === '/proc/12054/fd/52') return 'socket:[563764273]'
      return '/dev/null'
    }
    const diagnostics = { scanned: 0, fdDirUnreadable: 0, fdLinksFailed: 0, errors: [] as string[] }
    const pids = findPidsBySocketInodes(new Set([563764273]), listProcDir, readDirNames, readLink, diagnostics)
    expect(pids).toEqual([12054])
    expect(diagnostics.scanned).toBe(1)
    expect(diagnostics.fdLinksFailed).toBe(1)
    expect(diagnostics.fdDirUnreadable).toBe(0)
    expect(diagnostics.errors.length).toBe(1)
    expect(diagnostics.errors[0]).toContain('/proc/12054/fd/155')
  })

  it('multiple failing fds still find the listener (churn-heavy process)', () => {
    const listProcDir = () => ['12054']
    const readDirNames = () => ['1', '2', '3', '52', '4', '5', '6', '7']
    const readLink = (p: string) => {
      if (p === '/proc/12054/fd/52') return 'socket:[563764273]'
      throw new Error('ENOENT: fd gone')
    }
    const pids = findPidsBySocketInodes(new Set([563764273]), listProcDir, readDirNames, readLink)
    expect(pids).toEqual([12054])
  })
})

describe('auditPortOwnership — explicit /proc diagnostics (AC: no silent catch)', () => {
  it('container without host /proc visibility: fd dirs unreadable -> reason says so, diagnostics counted', async () => {
    // Simulates the audit running where /proc/<pid>/fd is not readable for
    // every pid (e.g. a per-app container seeing only its own namespace).
    const deps = {
      port: 10001,
      appName: 'teros-backend',
      readFile: (p: string) => {
        if (p === '/proc/net/tcp6') {
          return 'header\n   0: 00000000:2711 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 563764273 1 ...\n'
        }
        if (p === '/proc/net/tcp') return 'header\n'
        throw new Error('EACCES')
      },
      listProcDir: () => ['1', '2', '3', '12054'],
      readDirNames: () => {
        throw new Error("EACCES: permission denied, scandir '/proc/1/fd'")
      },
      readLink: () => {
        throw new Error('unreachable')
      },
    }
    const ownership = await auditPortOwnership(deps)
    expect(ownership.listenerPids).toEqual([])
    expect(ownership.ok).toBe(false)
    // The reason must NOT claim a clean 'no process is listening' — it must
    // surface the visibility problem explicitly.
    expect(ownership.reason).toContain('unreadable')
    expect(ownership.reason).toContain('container')
    expect(ownership.pidScan).not.toBeNull()
    expect(ownership.pidScan!.scanned).toBe(0)
    expect(ownership.pidScan!.fdDirUnreadable).toBe(4)
    expect(ownership.pidScan!.errors.length).toBeGreaterThan(0)
    expect(ownership.procNetReadErrors).toEqual([])
  })

  it('/proc/net/tcp(6) unreadable -> procNetReadErrors populated + UNKNOWN verdict', async () => {
    const deps = {
      port: 10001,
      appName: 'teros-backend',
      readFile: () => {
        throw new Error("EACCES: permission denied, open '/proc/net/tcp'")
      },
      listProcDir: () => ['1'],
      readDirNames: () => [],
      readLink: () => '/dev/null',
    }
    const ownership = await auditPortOwnership(deps)
    expect(ownership.listenerPids).toEqual([])
    expect(ownership.ok).toBe(false)
    expect(ownership.reason).toContain('cannot read /proc/net/tcp(6)')
    expect(ownership.reason).toContain('UNKNOWN')
    expect(ownership.procNetReadErrors.length).toBe(2)
    expect(ownership.procNetReadErrors[0]).toContain('/proc/net/tcp:')
  })

  it('healthy audit carries pidScan diagnostics without changing the verdict', async () => {
    const deps = {
      port: 10001,
      appName: 'teros-backend',
      env: { name: 'teros-backend', pm_pid_path: '/tmp/pm.pid' },
      readFile: (p: string) => {
        if (p === '/proc/net/tcp6') {
          return 'header\n   0: 00000000:2711 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 563764273 1 ...\n'
        }
        if (p === '/proc/net/tcp') return 'header\n'
        if (p === '/tmp/pm.pid') return '10949'
        throw new Error('unexpected ' + p)
      },
      listProcDir: () => ['12054'],
      readDirNames: (p: string) => {
        if (p === '/proc/12054/fd') return ['0', '52']
        throw new Error('unexpected ' + p)
      },
      readLink: (p: string) => {
        if (p === '/proc/12054/fd/52') return 'socket:[563764273]'
        if (p === '/proc/12054/fd/0') return '/dev/null'
        throw new Error('unexpected ' + p)
      },
      readStatus: (pid: number) => (pid === 12054 ? { pid: 12054, ppid: 10949 } : null),
      readEnviron: (pid: number) => {
        const map = new Map<string, string>()
        if (pid === 12054) {
          map.set('name', 'teros-backend')
          map.set('pm_id', '30')
          map.set('pm_pid_path', '/tmp/pm.pid')
        }
        return map
      },
      readCmdline: (pid: number) => (pid === 12054 ? 'node src/index.ts' : null),
      readCwd: (pid: number) => (pid === 12054 ? '/opt/teros/packages/backend' : null),
      runGit: async () => ({ stdout: 'a5fd04b82\n', stderr: '' }),
    }
    const ownership = await auditPortOwnership(deps)
    expect(ownership.ok).toBe(true)
    expect(ownership.listenerPids).toEqual([12054])
    expect(ownership.pidScan!.scanned).toBe(1)
    expect(ownership.pidScan!.fdLinksFailed).toBe(0)
    expect(ownership.procNetReadErrors).toEqual([])
  })
})

// ─── ppid-chain descent ──────────────────────────────────────────────────────

describe('descendsFrom', () => {
  it('walks the ppid chain to the ancestor', () => {
    // 300 → 200 → 100 (ancestor)
    const status = new Map<number, number>([
      [300, 200],
      [200, 100],
      [100, 1],
    ])
    const readStatus = (pid: number) => ({ pid, ppid: status.get(pid) ?? -1 })
    expect(descendsFrom(300, 100, 6, readStatus)).toBe(true)
    expect(descendsFrom(200, 100, 6, readStatus)).toBe(true)
  })

  it('a re-parented process (ppid 1) never matches — the orphan signature', () => {
    // The incident case: wrapper SIGKILLed, server child re-parented to init.
    const readStatus = (pid: number) => ({ pid, ppid: pid === 400 ? 1 : 999 })
    expect(descendsFrom(400, 100, 6, readStatus)).toBe(false)
  })

  it('false when the chain never reaches the ancestor within maxHops', () => {
    const readStatus = (pid: number) => ({ pid, ppid: pid + 1 })
    expect(descendsFrom(1, 500, 3, readStatus)).toBe(false)
  })

  it('false for vanished processes and invalid pids', () => {
    expect(descendsFrom(123, 100, 6, () => null)).toBe(false)
    expect(descendsFrom(0, 100)).toBe(false)
    expect(descendsFrom(100, 0)).toBe(false)
  })
})

// ─── pm2 identity ───────────────────────────────────────────────────────────

describe('currentPm2WrapperPid', () => {
  it('reads the wrapper pid from the pm2 pidfile via env markers', () => {
    const env = { pm_pid_path: '/home/alex/.pm2/pids/teros-backend-30.pid', name: 'teros-backend' }
    const readFile = () => '1409697\n'
    expect(currentPm2WrapperPid(env, readFile)).toBe(1409697)
  })

  it('null when not running under pm2 (no markers)', () => {
    expect(currentPm2WrapperPid({}, () => '1')).toBeNull()
  })

  it('null when the pidfile is unreadable or malformed', () => {
    const env = { pm_pid_path: '/x.pid', name: 'teros-backend' }
    expect(currentPm2WrapperPid(env, () => { throw new Error('ENOENT') })).toBeNull()
    expect(currentPm2WrapperPid(env, () => 'not-a-pid')).toBeNull()
  })
})

describe('inspectProcess / hasPm2EnvFor', () => {
  const pm2Proc: PortOwnerProcess = {
    pid: 1410434,
    ppid: 1409697,
    cmdline: 'node src/index.ts',
    cwd: '/opt/teros/packages/backend',
    pm2Env: true,
    pm2Name: 'teros-backend',
    pm2Id: 30,
  }
  it('flags pm2 env markers for the right app name', () => {
    expect(hasPm2EnvFor(pm2Proc, 'teros-backend')).toBe(true)
    expect(hasPm2EnvFor(pm2Proc, 'some-other-app')).toBe(false)
  })

  it('an orphan still carries env markers but is caught by descent, not env', () => {
    const orphan: PortOwnerProcess = { ...pm2Proc, ppid: 1 }
    expect(hasPm2EnvFor(orphan, 'teros-backend')).toBe(true) // env survives re-parenting
  })
})

// ─── audit verdicts ─────────────────────────────────────────────────────────

describe('auditPortOwnership', () => {
  const TCP = (port: number, inode: number) =>
    `   0: 00000000:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 ...`

  const makeDeps = (opts: {
    listenerPpid: number
    pm2Env?: boolean
    pm2Name?: string
    wrapperPidFile?: string | null
    port?: number
  }) => {
    // The fake /proc/net/tcp always has a listener on 10001; `opts.port`
    // selects which port the AUDIT looks at (≠10001 ⇒ nobody listens).
    const port = opts.port ?? 10001
    const inode = 424242
    const listenerPid = 1410434
    const wrapperPid = 1409697
    const env: Record<string, string> = { name: 'teros-backend' }
    const readFile = (p: string) => {
      if (p === '/proc/net/tcp') return `header\n${TCP(10001, inode)}`
      if (p === '/proc/net/tcp6') return 'header\n'
      if (p === '/home/alex/.pm2/pids/teros-backend-30.pid')
        return opts.wrapperPidFile === null ? (() => { throw new Error('ENOENT') })() : (opts.wrapperPidFile ?? String(wrapperPid))
      throw new Error(`unexpected read: ${p}`)
    }
    const listProcDir = () => [String(listenerPid)]
    const readDirNames = (p: string) => (p === `/proc/${listenerPid}/fd` ? ['51'] : [])
    const readLink = (p: string) => (p === `/proc/${listenerPid}/fd/51` ? 'socket:[424242]' : '/dev/null')
    const readStatus = (pid: number) => ({ pid, ppid: pid === listenerPid ? opts.listenerPpid : 1 })
    const readEnviron = (pid: number) => {
      const map = new Map<string, string>()
      if (pid === listenerPid) {
        map.set('name', 'teros-backend')
        map.set('pm_id', '30')
        map.set('pm_pid_path', '/home/alex/.pm2/pids/teros-backend-30.pid')
      }
      return map
    }
    const readCmdline = (pid: number) => (pid === listenerPid ? 'node src/index.ts' : null)
    const readCwd = (pid: number) => (pid === listenerPid ? '/opt/teros/packages/backend' : null)
    const runGit = async (args: string[]) => ({
      stdout: args[0] === 'rev-parse' ? 'abc123def456\n' : '',
      stderr: '',
    })
    return {
      deps: {
        port,
        appName: 'teros-backend',
        env: { ...env, pm_pid_path: '/home/alex/.pm2/pids/teros-backend-30.pid' },
        readFile,
        listProcDir,
        readDirNames,
        readLink,
        readStatus,
        readEnviron,
        readCmdline,
        readCwd,
        runGit,
      },
      listenerPid,
      wrapperPid,
    }
  }

  it('ok=true for the healthy case: listener is the pm2 wrapper child', async () => {
    const { deps, listenerPid, wrapperPid } = makeDeps({ listenerPpid: 1409697 })
    const result = await auditPortOwnership(deps)
    expect(result.ok).toBe(true)
    expect(result.listenerPids).toEqual([listenerPid])
    expect(result.pm2WrapperPid).toBe(wrapperPid)
    expect(result.listenerDescendsFromPm2).toBe(true)
    expect(result.listenerHasPm2Env).toBe(true)
    expect(result.checkout?.commit).toBe('abc123def456')
    expect(result.reason).toContain('descends from pm2 wrapper')
  })

  it('ok=false, orphan reason when the listener is re-parented (ppid 1) — the incident', async () => {
    const { deps, listenerPid } = makeDeps({ listenerPpid: 1 })
    const result = await auditPortOwnership(deps)
    expect(result.ok).toBe(false)
    expect(result.listenerDescendsFromPm2).toBe(false)
    expect(result.reason).toContain('does NOT descend from pm2 wrapper')
    expect(result.reason).toContain('orphan')
    expect(result.listenerPids).toEqual([listenerPid])
  })

  it('ok=false when nobody listens (pm2 up but portless)', async () => {
    const { deps } = makeDeps({ listenerPpid: 1409697, port: 19999 })
    const result = await auditPortOwnership(deps)
    expect(result.ok).toBe(false)
    expect(result.listenerPids).toEqual([])
    expect(result.reason).toContain('no process is listening')
  })

  it('ok=false when not running under pm2 (pidfile gone)', async () => {
    const { deps } = makeDeps({ listenerPpid: 1409697, wrapperPidFile: null })
    const result = await auditPortOwnership(deps)
    expect(result.ok).toBe(false)
    expect(result.pm2WrapperPid).toBeNull()
    expect(result.listenerDescendsFromPm2).toBeNull()
    expect(result.reason).toContain('not running under pm2')
  })
})

// ─── kill guard rails ───────────────────────────────────────────────────────

describe('killForeignPortHolders', () => {
  const TCP = (inode: number) =>
    `   0: 00000000:2711 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 ...`

  const setup = (listenerPid: number, listenerPpid: number) => {
    const killed: Array<[number, string | undefined]> = []
    const deps = {
      port: 10001,
      appName: 'teros-backend',
      env: { name: 'teros-backend', pm_pid_path: '/home/p/.pm2/pids/teros-backend-30.pid' },
      readFile: (p: string) => {
        if (p === '/proc/net/tcp') return `header\n${TCP(424242)}`
        if (p === '/proc/net/tcp6') return 'header\n'
        if (p === '/home/p/.pm2/pids/teros-backend-30.pid') return '1409697\n'
        throw new Error(`unexpected: ${p}`)
      },
      listProcDir: () => [String(listenerPid)],
      readDirNames: (p: string) => (p === `/proc/${listenerPid}/fd` ? ['51'] : []),
      readLink: (p: string) => (p === `/proc/${listenerPid}/fd/51` ? 'socket:[424242]' : '/dev/null'),
      readStatus: (pid: number) => ({ pid, ppid: pid === listenerPid ? listenerPpid : 1 }),
      kill: (pid: number, signal?: string) => {
        killed.push([pid, signal])
      },
      sleep: async () => {},
      killEscalationMs: 0,
    }
    return { deps, killed }
  }

  it('NEVER kills a listener that descends from the pm2 wrapper (no-op)', async () => {
    const { deps, killed } = setup(1410434, 1409697) // child of wrapper
    const { killed: killedPids } = await killForeignPortHolders(deps)
    expect(killedPids).toEqual([])
    expect(killed).toEqual([])
  })

  it('kills an orphan listener: SIGTERM then SIGKILL', async () => {
    const { deps, killed } = setup(2503098, 1) // re-parented orphan (incident pid)
    const { killed: killedPids } = await killForeignPortHolders(deps)
    expect(killedPids).toEqual([2503098])
    expect(killed).toEqual([
      [2503098, 'SIGTERM'],
      [2503098, 'SIGKILL'],
    ])
  })

  it('never kills the pm2 wrapper itself even if it held the port', async () => {
    const { deps, killed } = setup(1409697, 283293) // wrapper pid as listener
    const { killed: killedPids } = await killForeignPortHolders(deps)
    expect(killedPids).toEqual([])
    expect(killed).toEqual([])
  })

  it('no-op when nothing listens', async () => {
    const deps = {
      port: 19998,
      appName: 'teros-backend',
      env: {},
      readFile: (p: string) => (p === '/proc/net/tcp' || p === '/proc/net/tcp6' ? 'header\n' : ''),
      listProcDir: () => [] as string[],
      readDirNames: () => [] as string[],
      kill: () => { throw new Error('should not be called') },
      sleep: async () => {},
    }
    const { killed } = await killForeignPortHolders(deps)
    expect(killed).toEqual([])
  })
})
