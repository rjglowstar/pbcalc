const { execFile } = require("child_process");
const os = require("os");

// What only Windows can tell: the edition, memory + commit + page file, how busy the whole computer / the disk is right now (3 readings, 1 s apart), WHO is using the CPU
// and the memory (program names only), WHICH APPS ARE OPEN (Task Manager's "Apps" group only, each with all its processes' memory), antivirus, disk kind, power plan,
// and the crash / hang entries of PBCalc.exe in the Event Log WITH the faulting module and the exception code.
// Three asynchronous PowerShell runs side by side (never on the main thread): one slow part (the Event Log, the 3-second load reading) can no longer take the others down
// with it - the first version was ONE script with one time-out, and on a real PC it came back empty ("unavailable") with no reason. Every failure now says WHY
// (`errors`: timeout / exit code / first words of the error / not JSON), and memory falls back to Node's own figures.
const UTF8 = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $o = [ordered]@{};";
const END = "$o | ConvertTo-Json -Compress -Depth 5";

const PART_NOW = [UTF8,
  "try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop; $o.osCaption = $os.Caption; $o.osBuild = $os.BuildNumber; $o.memory = [ordered]@{ physTotalMB = [int]($os.TotalVisibleMemorySize / 1024); physFreeMB = [int]($os.FreePhysicalMemory / 1024); commitLimitMB = [int]($os.TotalVirtualMemorySize / 1024); commitFreeMB = [int]($os.FreeVirtualMemory / 1024) } } catch {}",
  "try { $o.pageFile = @(Get-CimInstance Win32_PageFileUsage -ErrorAction Stop | ForEach-Object { [ordered]@{ sizeMB = $_.AllocatedBaseSize; usedMB = $_.CurrentUsage; peakMB = $_.PeakUsage } }) } catch {}",
  // the APPS list = Task Manager's "Apps" group ONLY (owner, 2026-10-10: no Background / Windows processes): programs that have a window with a title, each with the memory
  // of ALL its processes (Chrome = its 40 helper processes together, like Task Manager shows). Windows' own hosts are left out.
  "try { $all = @(Get-Process -ErrorAction Stop); $skip = 'ApplicationFrameHost','TextInputHost','svchost','RtkUWP','SystemSettings','ShellExperienceHost','SearchHost','StartMenuExperienceHost','LockApp','dwm';" +
  " $names = @($all | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -ne '' -or $_.ProcessName -eq 'explorer') -and $skip -notcontains $_.ProcessName } | ForEach-Object { $_.ProcessName } | Select-Object -Unique);" +
  " $o.openApps = @($names | ForEach-Object { $n = $_; $g = @($all | Where-Object { $_.ProcessName -eq $n }); [pscustomobject]@{ name = $n; windows = @($g | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' }).Count; processes = $g.Count; workingSetMB = [int](($g | Measure-Object WorkingSet64 -Sum).Sum / 1MB) } } | Sort-Object workingSetMB -Descending) } catch {}",
  "try { $o.antivirus = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -ErrorAction Stop | ForEach-Object { $_.displayName }) } catch { $o.antivirus = 'unavailable' }",
  "try { $o.disks = @(Get-PhysicalDisk -ErrorAction Stop | ForEach-Object { $_.MediaType + '/' + $_.BusType }) } catch { $o.disks = 'unavailable' }",
  "try { $m = [regex]::Match((powercfg /getactivescheme | Out-String), '\\((.*)\\)'); $o.powerPlan = $m.Groups[1].Value } catch { $o.powerPlan = 'unavailable' }",
  "try { $o.startupPrograms = @(Get-CimInstance Win32_StartupCommand -ErrorAction Stop | ForEach-Object { $_.Name } | Select-Object -Unique -First 30) } catch {}",
  // the machine itself (make / model, a virtual machine or real hardware) and the processor's clock now vs its maximum (a PC held back by its power plan or by heat runs far below it)
  "try { $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop; $o.machine = [ordered]@{ manufacturer = [string]$cs.Manufacturer; model = [string]$cs.Model; hypervisor = [bool]$cs.HypervisorPresent } } catch {}",
  "try { $cp = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1; $o.cpuClock = [ordered]@{ currentMHz = [int]$cp.CurrentClockSpeed; maxMHz = [int]$cp.MaxClockSpeed; cores = [int]$cp.NumberOfCores } } catch {}",
  END].join(" ");

// the load figures are three WMI performance queries; they stall independently (a stalled one used to take all three down for the whole time-out), so each is its own part
const PART_CPU = [UTF8,
  "try { $c = @(); for ($i = 0; $i -lt 3; $i++) { $c += (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\" -ErrorAction Stop).PercentProcessorTime; if ($i -lt 2) { Start-Sleep -Seconds 1 } }; $o.cpuPct = [math]::Round(($c | Measure-Object -Average).Average, 1) } catch {}",
  END].join(" ");
const PART_DISK = [UTF8,
  "try { $d = @(); $q = @(); for ($i = 0; $i -lt 3; $i++) { $x = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter \"Name='_Total'\" -ErrorAction Stop; $d += $x.PercentDiskTime; $q += $x.CurrentDiskQueueLength; if ($i -lt 2) { Start-Sleep -Seconds 1 } }; $o.diskPct = [math]::Round(($d | Measure-Object -Average).Average, 1); $o.diskQueue = [math]::Round(($q | Measure-Object -Average).Average, 2) } catch {}",
  END].join(" ");
// memory that is REALLY available (free + the cache Windows gives back at once; the plain "free" figure ignores that cache) and whether Windows is swapping right now (hard page faults)
const PART_MEM = [UTF8,
  "try { $a = @(); $pi = @(); $pr = @(); for ($i = 0; $i -lt 3; $i++) { $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop; $a += $m.AvailableMBytes; $pi += $m.PagesInputPersec; $pr += $m.PageReadsPersec; if ($i -lt 2) { Start-Sleep -Milliseconds 700 } }; $o.memory2 = [ordered]@{ availableMB = [int]($a | Measure-Object -Minimum).Minimum; pagesInPerSec = [int]($pi | Measure-Object -Maximum).Maximum; pageReadsPerSec = [int]($pr | Measure-Object -Maximum).Maximum; commitPct = [int]$m.PercentCommittedBytesInUse; cacheMB = [int]($m.CacheBytes / 1MB) } } catch {}",
  END].join(" ");
const PART_LOAD = PART_CPU;   // (kept for the one-script export below)

const PART_EVENTS = [UTF8,
  "try { $o.pbcalcEvents = @(Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1002} -MaxEvents 80 -ErrorAction Stop | Where-Object { $_.Message -match 'PBCalc' } | Select-Object -First 8 | ForEach-Object { $m = $_.Message; [ordered]@{ at = $_.TimeCreated.ToString('s'); id = $_.Id; app = ([regex]::Match($m, '(?:Faulting application name|The program) ?:? ?([^,\\r\\n ]+)').Groups[1].Value); module = ([regex]::Match($m, 'Faulting module name: ([^,\\r\\n]+)').Groups[1].Value); code = ([regex]::Match($m, 'Exception code: (\\S+)').Groups[1].Value) } }) } catch { $o.pbcalcEvents = @() }",
  END].join(" ");

// who uses the CPU right now (Win32_PerfFormattedData_PerfProc_Process walks every process: the slowest WMI query here, so it has its own part and cannot take the load figures down)
const PART_TOPCPU = [UTF8,
  "try { $o.topCpu = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction Stop | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 8 | ForEach-Object { [ordered]@{ name = ($_.Name -replace '#\\d+$', ''); cpuOfOneCore = $_.PercentProcessorTime; memMB = [int]($_.WorkingSetPrivate / 1MB) } }) } catch {}",
  END].join(" ");

// the same list WITHOUT WMI (Get-Process twice, 1.5 s apart): used when the WMI performance query stalls - it did, on two PCs, for its whole time-out
const PART_TOPCPU_NOWMI = [UTF8,
  "try { $a = @{}; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { if ($_.CPU -ne $null) { $a[$_.Id] = $_.CPU } }; Start-Sleep -Milliseconds 1500;" +
  " $o.topCpu = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.CPU -ne $null -and $a.ContainsKey($_.Id) } | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; cpu = [int](([double]$_.CPU - $a[$_.Id]) / 1.5 * 100); mem = [int]($_.WorkingSet64 / 1MB) } } | Sort-Object cpu -Descending | Select-Object -First 8 | ForEach-Object { [ordered]@{ name = $_.name; cpuOfOneCore = $_.cpu; memMB = $_.mem } }); $o.topCpuFrom = 'Get-Process' } catch {}",
  END].join(" ");

// the antivirus (is real-time protection on, is it scanning right now): its own part, because Get-MpComputerStatus is sometimes slow and must not hold the others up
const PART_DEFENDER = [UTF8,
  "try { $s = Get-MpComputerStatus -ErrorAction Stop; $o.defender = [ordered]@{ realTime = [bool]$s.RealTimeProtectionEnabled; scanning = [bool]($s.FullScanRunning -or $s.QuickScanRunning) } } catch {}",
  END].join(" ");

// kept for the tests / tools that want the whole thing in one script
const WIN_FACTS = [PART_NOW, PART_LOAD, PART_EVENTS].join(" ");

function runPart(name, script, timeoutMs, errors, env) {
  return new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 << 20, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
          if (err) {
            errors[name] = err.killed ? "timeout after " + Math.round(timeoutMs / 1000) + " s" : (err.code != null ? "exit " + err.code : "") + " " + String(stderr || err.message || "").replace(/\s+/g, " ").trim().slice(0, 160);
            return resolve({});
          }
          const text = String(stdout || "").trim();
          try { resolve(JSON.parse(text.slice(text.indexOf("{")))); } catch (_) { errors[name] = "answer was not JSON: " + text.slice(0, 80).replace(/\s+/g, " "); resolve({}); }
        });
    } catch (e) { errors[name] = "could not start: " + String(e && e.message).slice(0, 120); resolve({}); }
  });
}

// drive kinds + signed-in users: storage / session queries are slow and WMI stalls when several run at once (this part measurably made the load figures time out), so it runs AFTER the others
const PART_STORAGE = [UTF8,
  // which kind of disk each drive letter is on (PBCalc's own files and its data folder may sit on the slow one) and how many Windows users are signed in on this PC (other users' programs keep running)
  "try { $o.driveMedia = @(Get-Partition -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object { $dn = $_.DiskNumber; $pd = Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.DeviceId -eq [string]$dn } | Select-Object -First 1; [ordered]@{ drive = [string]$_.DriveLetter; media = $(if ($pd) { [string]$pd.MediaType } else { '' }); bus = $(if ($pd) { [string]$pd.BusType } else { '' }) } }) } catch {}",
  "try { $o.interactiveSessions = @(Get-CimInstance Win32_LogonSession -ErrorAction Stop | Where-Object { $_.LogonType -eq 2 -or $_.LogonType -eq 10 }).Count } catch {}",
  // free space on EVERY drive (a full system drive makes Windows and the browser crawl)
  "try { $o.volumes = @(Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object { [ordered]@{ drive = [string]$_.DriveLetter; fs = [string]$_.FileSystemType; sizeGB = [math]::Round($_.Size / 1GB, 1); freeGB = [math]::Round($_.SizeRemaining / 1GB, 1) } }) } catch {}",
  // Windows resources a heavy browser can exhaust long before memory is gone: handles, threads and GDI / USER objects (a process may hold 10000 of each by default - past that, windows stop drawing and the program hangs)
  "try { $ids = @($env:PBC_PIDS -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ }); $ps = @(Get-Process -Id $ids -ErrorAction SilentlyContinue);" +
  " $sig = '[DllImport(\"user32.dll\")] public static extern uint GetGuiResources(System.IntPtr h, uint f);'; Add-Type -MemberDefinition $sig -Name G -Namespace W2;" +
  " $gdi = 0; $usr = 0; $worstG = 0; $worstU = 0; foreach ($q in $ps) { try { $g = [W2.G]::GetGuiResources($q.Handle, 0); $u = [W2.G]::GetGuiResources($q.Handle, 1); $gdi += $g; $usr += $u; if ($g -gt $worstG) { $worstG = $g }; if ($u -gt $worstU) { $worstU = $u } } catch {} };" +
  " $all = @(Get-Process -ErrorAction SilentlyContinue); $o.resources = [ordered]@{ pbcalcProcesses = $ps.Count; pbcalcHandles = [int](($ps | Measure-Object Handles -Sum).Sum); pbcalcThreads = [int](($ps | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum); gdiObjects = [int]$gdi; userObjects = [int]$usr; worstProcessGdi = [int]$worstG; worstProcessUser = [int]$worstU; systemHandles = [int](($all | Measure-Object Handles -Sum).Sum); systemProcesses = $all.Count } } catch {}",
  END].join(" ");

// the Windows logs of the last 14 days (counts and names only): unexpected shutdowns, disk errors, "low memory" warnings that NAME the program that ate it, hardware errors, and which programs crash / hang on this PC
const PART_LOG = [UTF8,
  "$since = (Get-Date).AddDays(-14);",
  "try { $sys = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $since; Id = 41,7,11,51,55,98,129,153,2004,17,18,19,20 } -MaxEvents 400 -ErrorAction Stop);" +
  " $o.systemLog = [ordered]@{ unexpectedShutdowns = @($sys | Where-Object { $_.Id -eq 41 }).Count; diskErrors = @($sys | Where-Object { @(7,11,51,55,98,129,153) -contains $_.Id -and $_.ProviderName -match 'disk|ntfs|stor|nvme|iaStor|volmgr' }).Count; lowMemoryWarnings = @($sys | Where-Object { $_.Id -eq 2004 }).Count; hardwareErrors = @($sys | Where-Object { $_.ProviderName -match 'WHEA' }).Count } } catch {}",
  // the newest low-memory warning lists the programs that used the most (Windows writes their names and sizes into it)
  "try { $r = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Resource-Exhaustion-Detector'; Id = 2004 } -MaxEvents 1 -ErrorAction Stop; $o.lowMemoryDetail = [ordered]@{ at = $r.TimeCreated.ToString('s'); top = @([regex]::Matches($r.Message, '([A-Za-z0-9_.\-]+\.exe) \(\d+\) consumed (\d+) bytes') | Select-Object -First 5 | ForEach-Object { [ordered]@{ name = $_.Groups[1].Value; mb = [int]([int64]$_.Groups[2].Value / 1MB) } }) } } catch {}",
  "try { $ap = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since; Id = 1000,1002 } -MaxEvents 300 -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ id = $_.Id; app = ([regex]::Match($_.Message, '(?:Faulting application name|The program) ?:? ?([^,\r\n ]+)').Groups[1].Value) } });" +
  " $o.appFailures = @($ap | Group-Object app | Sort-Object Count -Descending | Select-Object -First 8 | ForEach-Object { [ordered]@{ app = [string]$_.Name; crashes = @($_.Group | Where-Object { $_.id -eq 1000 }).Count; hangs = @($_.Group | Where-Object { $_.id -eq 1002 }).Count } }) } catch {}",
  END].join(" ");

// just "who uses the CPU right now" (about 2-4 s) - the recorder calls it while the whole PC is busy, so the report can name the program that was busy THEN (the snapshot at send time is usually quiet)
async function topCpuNow(timeoutMs = 20000) {
  if (process.platform !== "win32") return null;
  const errors = {};
  let r = await runPart("topCpu", PART_TOPCPU, timeoutMs, errors);
  if (!Array.isArray(r.topCpu)) r = await runPart("topCpuFallback", PART_TOPCPU_NOWMI, 15000, errors);
  return Array.isArray(r.topCpu) ? r.topCpu : null;
}

async function windowsFacts(opts = {}) {
  if (process.platform !== "win32") return {};
  const errors = {}, t = opts.timeoutMs || 20000;
  const [now, cpu, disk, mem, ev, df, tc] = await Promise.all([runPart("now", PART_NOW, t, errors), runPart("cpu", PART_CPU, 12000, errors), runPart("disk", PART_DISK, 12000, errors), runPart("memory", PART_MEM, 12000, errors), runPart("events", PART_EVENTS, t, errors), runPart("defender", PART_DEFENDER, 15000, errors), runPart("topCpu", PART_TOPCPU, 20000, errors)]);
  const out = { ...now, ...ev, ...df, ...tc };
  if (cpu.cpuPct != null || disk.diskPct != null) out.load = { cpuPct: cpu.cpuPct == null ? null : cpu.cpuPct, diskPct: disk.diskPct == null ? null : disk.diskPct, diskQueue: disk.diskQueue == null ? null : disk.diskQueue };
  if (mem.memory2) out.memory2 = mem.memory2;
  // the WMI query for the busiest programs stalled for its whole time-out on two PCs: take the list from Get-Process instead, and say so
  if (!Array.isArray(out.topCpu)) Object.assign(out, await runPart("topCpuFallback", PART_TOPCPU_NOWMI, 15000, errors));
  const env = { PBC_PIDS: (opts.pids || []).join(",") };
  const [stor, log] = await Promise.all([runPart("storage", PART_STORAGE, 20000, errors, env), runPart("log", PART_LOG, 20000, errors)]);
  Object.assign(out, stor, log);
  if (!out.memory) out.memory = { physTotalMB: Math.round(os.totalmem() / 1048576), physFreeMB: Math.round(os.freemem() / 1048576), commitLimitMB: null, commitFreeMB: null, fromNode: true };
  if (Object.keys(errors).length) out.errors = errors;
  // "unavailable" only when PowerShell gave NOTHING at all
  if (errors.now && errors.cpu && errors.disk && errors.memory && errors.events && errors.defender) out.unavailable = true;
  return out;
}

module.exports = { windowsFacts, topCpuNow, WIN_FACTS };
