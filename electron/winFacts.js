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
  END].join(" ");

const PART_LOAD = [UTF8,
  "try { $c = @(); $d = @(); $q = @(); for ($i = 0; $i -lt 3; $i++) { $c += (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\" -ErrorAction Stop).PercentProcessorTime; $x = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter \"Name='_Total'\" -ErrorAction Stop; $d += $x.PercentDiskTime; $q += $x.CurrentDiskQueueLength; if ($i -lt 2) { Start-Sleep -Seconds 1 } }; $o.load = [ordered]@{ cpuPct = [math]::Round(($c | Measure-Object -Average).Average, 1); diskPct = [math]::Round(($d | Measure-Object -Average).Average, 1); diskQueue = [math]::Round(($q | Measure-Object -Average).Average, 2) } } catch {}",
  // memory that is REALLY available (free + the cache Windows gives back at once; the plain "free" figure ignores that cache) and whether Windows is swapping right now (hard page faults)
  "try { $a = @(); $pi = @(); $pr = @(); for ($i = 0; $i -lt 3; $i++) { $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop; $a += $m.AvailableMBytes; $pi += $m.PagesInputPersec; $pr += $m.PageReadsPersec; if ($i -lt 2) { Start-Sleep -Milliseconds 700 } }; $o.memory2 = [ordered]@{ availableMB = [int]($a | Measure-Object -Minimum).Minimum; pagesInPerSec = [int]($pi | Measure-Object -Maximum).Maximum; pageReadsPerSec = [int]($pr | Measure-Object -Maximum).Maximum; commitPct = [int]$m.PercentCommittedBytesInUse; cacheMB = [int]($m.CacheBytes / 1MB) } } catch {}",
  END].join(" ");

const PART_EVENTS = [UTF8,
  "try { $o.pbcalcEvents = @(Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1002} -MaxEvents 80 -ErrorAction Stop | Where-Object { $_.Message -match 'PBCalc' } | Select-Object -First 8 | ForEach-Object { $m = $_.Message; [ordered]@{ at = $_.TimeCreated.ToString('s'); id = $_.Id; app = ([regex]::Match($m, '(?:Faulting application name|The program) ?:? ?([^,\\r\\n ]+)').Groups[1].Value); module = ([regex]::Match($m, 'Faulting module name: ([^,\\r\\n]+)').Groups[1].Value); code = ([regex]::Match($m, 'Exception code: (\\S+)').Groups[1].Value) } }) } catch { $o.pbcalcEvents = @() }",
  END].join(" ");

// who uses the CPU right now (Win32_PerfFormattedData_PerfProc_Process walks every process: the slowest WMI query here, so it has its own part and cannot take the load figures down)
const PART_TOPCPU = [UTF8,
  "try { $o.topCpu = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction Stop | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 8 | ForEach-Object { [ordered]@{ name = ($_.Name -replace '#\\d+$', ''); cpuOfOneCore = $_.PercentProcessorTime; memMB = [int]($_.WorkingSetPrivate / 1MB) } }) } catch {}",
  END].join(" ");

// the antivirus (is real-time protection on, is it scanning right now): its own part, because Get-MpComputerStatus is sometimes slow and must not hold the others up
const PART_DEFENDER = [UTF8,
  "try { $s = Get-MpComputerStatus -ErrorAction Stop; $o.defender = [ordered]@{ realTime = [bool]$s.RealTimeProtectionEnabled; scanning = [bool]($s.FullScanRunning -or $s.QuickScanRunning) } } catch {}",
  END].join(" ");

// kept for the tests / tools that want the whole thing in one script
const WIN_FACTS = [PART_NOW, PART_LOAD, PART_EVENTS].join(" ");

function runPart(name, script, timeoutMs, errors) {
  return new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 << 20, encoding: "utf8" }, (err, stdout, stderr) => {
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

async function windowsFacts(opts = {}) {
  if (process.platform !== "win32") return {};
  const errors = {}, t = opts.timeoutMs || 20000;
  const [now, load, ev, df, tc] = await Promise.all([runPart("now", PART_NOW, t, errors), runPart("load", PART_LOAD, t, errors), runPart("events", PART_EVENTS, t, errors), runPart("defender", PART_DEFENDER, 15000, errors), runPart("topCpu", PART_TOPCPU, 20000, errors)]);
  const out = { ...now, ...load, ...ev, ...df, ...tc };
  if (!out.memory) out.memory = { physTotalMB: Math.round(os.totalmem() / 1048576), physFreeMB: Math.round(os.freemem() / 1048576), commitLimitMB: null, commitFreeMB: null, fromNode: true };
  if (Object.keys(errors).length) out.errors = errors;
  // "unavailable" only when PowerShell gave NOTHING at all
  if (errors.now && errors.load && errors.events && errors.defender && errors.topCpu) out.unavailable = true;
  return out;
}

module.exports = { windowsFacts, WIN_FACTS };
