import AtcRadar from "./AtcRadar";
import KsfoRadar, { type SurfaceAircraft } from "./KsfoRadar";
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Wind, ShieldAlert, Cpu, Sparkles, Plane, Leaf, DollarSign, WifiOff, Play, Pause, Volume2, VolumeX, RotateCcw, Radio, Sun, Moon, Maximize2, Minimize2, Activity } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import AirspaceScene from './components/AirspaceScene';
import StarsRadar from './components/StarsRadar';
import TowerWorkstation from './components/TowerWorkstation';
import {
  AIRPORTS,
  INITIAL_FLIGHTS,
  analyzeFlightPair,
  computeLiveWake,
  type AirportCode,
  type FlightRecord,
  type SimulationParams,
} from './physics/wakeEngine';

interface WeatherObservation {
  rawOb: string;
  wspd: number | null;
  wdir: number | null;
  wgst: number | null;
  altim: number | null;
  fltCat: string | null;
}

function getSurfaceDemoLeadFlight(callsign: string): FlightRecord {
  return { ...INITIAL_FLIGHTS[0], callsign };
}

function getSurfaceDemoFlights(callsign: string | null): FlightRecord[] {
  if (!callsign) return INITIAL_FLIGHTS;

  const leadFlight = getSurfaceDemoLeadFlight(callsign);
  return [
    leadFlight,
    ...INITIAL_FLIGHTS.filter(
      (flight) => flight.callsign !== INITIAL_FLIGHTS[0].callsign && flight.callsign !== callsign
    ),
  ];
}

export default function App() {
  const [activeScreen, setActiveScreen] = useState<"DEMO" | "ATC" | "KSFO">("DEMO");
  const [activeView, setActiveView] = useState<"DEMO" | "ATC_RADAR" | "KSFO_RADAR">("DEMO");
  const [flights, setFlights] = useState<FlightRecord[]>(INITIAL_FLIGHTS);
  const [selectedSurfaceCallsign, setSelectedSurfaceCallsign] = useState<string | null>(null);
  const [lightMode, setLightMode] = useState(false);
  const [focusTrigger, setFocusTrigger] = useState(0);
  const [feedMode, setFeedMode] = useState<'SIM' | 'REALTIME'>('SIM');
  const [realtimeStatus, setRealtimeStatus] = useState<
    'SYNCING' | 'BACKEND LIVE (DEMO VALUES)' | 'INSUFFICIENT LIVE TRAFFIC — SHOWING SIM' | 'BACKEND UNAVAILABLE — SHOWING SIM'
  >('SYNCING');
  const [isFullscreen3D, setIsFullscreen3D] = useState(false);

  const [params, setParams] = useState<SimulationParams>({
    airport: 'KSFO',
    leadFlightId: 'UAL863',
    followingFlightId: 'DAL1428',
    trajectoryThresholdNm: 3.0,
    crosswindKts: 1.5,
    windAngleDeg: 90,
    windDirectionDeg: 20,
    windSpeedKts: 10,
    offlineEdgeMode: false,
    isPlaying: true,
    voiceEnabled: true,
    autoWatchdog: false,
    showHazardZones: true,
    aircraftScale: 1.0,
  });

  const [viewMode, setViewMode] = useState<'3D' | 'STARS'>('3D');
  const [liveMetar, setLiveMetar] = useState<string>(AIRPORTS.KSFO.metarFallback);
  const [weatherObservation, setWeatherObservation] = useState<WeatherObservation | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentResponse, setAgentResponse] = useState<{
    mode: string;
    atc_advisory: string;
    tool_trace: string[];
    recommended_lateral_offset_m: number;
    recommended_altitude_offset_ft: number;
  } | null>(null);

  const leadFlight = useMemo(
    () => flights.find((f) => f.callsign === params.leadFlightId) || flights[0],
    [flights, params.leadFlightId]
  );

  const followingFlight = useMemo(
    () => flights.find((f) => f.callsign === params.followingFlightId && f.callsign !== leadFlight.callsign) || flights[1],
    [flights, params.followingFlightId, leadFlight.callsign]
  );

  const telemetry = useMemo(
    () =>
      computeLiveWake(leadFlight, followingFlight, params, {
        lateralM: agentResponse?.recommended_lateral_offset_m ?? 0,
        altitudeFt: agentResponse?.recommended_altitude_offset_ft ?? 0,
      }),
    [leadFlight, followingFlight, params, agentResponse]
  );

  const matrixAnalyses = useMemo(() => {
    const pairs = [];
    for (let i = 0; i < flights.length; i++) {
      for (let j = i + 1; j < flights.length; j++) {
        pairs.push(analyzeFlightPair(flights[i], flights[j], params));
      }
    }
    return pairs;
  }, [flights, params]);

  useEffect(() => {
    const spec = AIRPORTS[params.airport];
    setLiveMetar(spec.metarFallback);
    setWeatherObservation(null);
    if (params.offlineEdgeMode) return;

    fetch(`http://localhost:3001/api/weather?airport=${params.airport}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Weather API returned HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (Array.isArray(data) && data[0]?.rawOb) {
          const observation: WeatherObservation = {
            rawOb: data[0].rawOb,
            wspd: typeof data[0].wspd === 'number' ? data[0].wspd : null,
            wdir: typeof data[0].wdir === 'number' ? data[0].wdir : null,
            wgst: typeof data[0].wgst === 'number' ? data[0].wgst : null,
            altim: typeof data[0].altim === 'number' ? data[0].altim : null,
            fltCat: typeof data[0].fltCat === 'string' ? data[0].fltCat : null,
          };
          setWeatherObservation(observation);
          setLiveMetar(observation.rawOb);
          if (feedMode === 'REALTIME' && observation.wspd !== null) {
            const wdir = observation.wdir ?? spec.runwayHeading + 45;
            const angleRad = ((wdir - spec.runwayHeading) * Math.PI) / 180;
            const xwind = Math.min(20, Math.round(Math.abs(observation.wspd * Math.sin(angleRad)) * 10) / 10);
            setParams((p) => ({ ...p, crosswindKts: xwind }));
          }
        } else {
          setWeatherObservation(null);
        }
      })
      .catch((error: unknown) => {
        console.error('Weather API request failed', error);
        setLiveMetar(`METAR UNAVAILABLE · ${spec.metarFallback}`);
      });
  }, [params.airport, params.offlineEdgeMode, feedMode]);

  useEffect(() => {
    if (feedMode !== 'REALTIME') {
      const simulationFlights = getSurfaceDemoFlights(selectedSurfaceCallsign);
      setFlights(simulationFlights);
      if (selectedSurfaceCallsign) {
        setParams((current) => ({
          ...current,
          leadFlightId: selectedSurfaceCallsign,
          followingFlightId:
            simulationFlights.some(
              (flight) =>
                flight.callsign === current.followingFlightId &&
                flight.callsign !== selectedSurfaceCallsign
            )
              ? current.followingFlightId
              : simulationFlights.find((flight) => flight.callsign !== selectedSurfaceCallsign)?.callsign
                ?? simulationFlights[0].callsign,
        }));
      }
      setRealtimeStatus('SYNCING');
      return;
    }

    const syncRealtimeAtc = async () => {
      try {
        const res = await fetch(`http://localhost:3001/api/live-flights?airport=${params.airport}`);
        if (!res.ok) throw new Error('Backend unavailable');
        const data = await res.json();
        if (Array.isArray(data.flights) && data.flights.length >= 2) {
          const liveFlights = data.flights as FlightRecord[];
          const surfaceLeadFlight = selectedSurfaceCallsign
            ? getSurfaceDemoLeadFlight(selectedSurfaceCallsign)
            : null;
          const availableFlights = surfaceLeadFlight
            ? [
                surfaceLeadFlight,
                ...liveFlights.filter((flight) => flight.callsign !== surfaceLeadFlight.callsign),
              ]
            : liveFlights;
          setFlights(availableFlights);
          setParams((current) => {
            const callsigns = new Set(availableFlights.map((flight) => flight.callsign));
            const leadFlightId = surfaceLeadFlight
              ? surfaceLeadFlight.callsign
              : callsigns.has(current.leadFlightId)
              ? current.leadFlightId
              : availableFlights[0].callsign;
            const followingFlightId =
              callsigns.has(current.followingFlightId) && current.followingFlightId !== leadFlightId
                ? current.followingFlightId
                : availableFlights.find((flight) => flight.callsign !== leadFlightId)?.callsign
                  ?? availableFlights[0].callsign;
            return { ...current, leadFlightId, followingFlightId };
          });
          if (typeof data.crosswind_kts === 'number') {
            setParams((p) => ({ ...p, crosswindKts: data.crosswind_kts }));
          }
          setRealtimeStatus('BACKEND LIVE (DEMO VALUES)');
          return;
        }
        const fallbackFlights = getSurfaceDemoFlights(selectedSurfaceCallsign);
        setFlights(fallbackFlights);
        setParams((current) => ({
          ...current,
          leadFlightId: selectedSurfaceCallsign ?? INITIAL_FLIGHTS[0].callsign,
          followingFlightId:
            fallbackFlights.find((flight) => flight.callsign !== (selectedSurfaceCallsign ?? INITIAL_FLIGHTS[0].callsign))?.callsign
              ?? fallbackFlights[1].callsign,
        }));
        setRealtimeStatus('INSUFFICIENT LIVE TRAFFIC — SHOWING SIM');
      } catch {
        const fallbackFlights = getSurfaceDemoFlights(selectedSurfaceCallsign);
        setFlights(fallbackFlights);
        setParams((current) => ({
          ...current,
          leadFlightId: selectedSurfaceCallsign ?? INITIAL_FLIGHTS[0].callsign,
          followingFlightId:
            fallbackFlights.find((flight) => flight.callsign !== (selectedSurfaceCallsign ?? INITIAL_FLIGHTS[0].callsign))?.callsign
              ?? fallbackFlights[1].callsign,
        }));
        setRealtimeStatus('BACKEND UNAVAILABLE — SHOWING SIM');
      }
    };

    syncRealtimeAtc();
    const interval = setInterval(syncRealtimeAtc, 5000);
    return () => clearInterval(interval);
  }, [feedMode, params.airport, selectedSurfaceCallsign]);

  const speakAtcClearance = useCallback((text: string) => {
    if (!params.voiceEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  }, [params.voiceEnabled]);

  const triggerAtcAgent = useCallback(async () => {
    setAgentLoading(true);
    const airportSpec = AIRPORTS[params.airport];
    const hasConflict = telemetry.wakeEncounter || telemetry.trajectoryConflict || telemetry.riskScore >= 35;

    const advisoryText = hasConflict
      ? `SIMULATION ONLY — not operational guidance. ${telemetry.conflictLabel} modeled between ${leadFlight.callsign} and ${followingFlight.callsign}.`
      : `SIMULATION ONLY — not operational guidance. No modeled conflict detected between ${leadFlight.callsign} and ${followingFlight.callsign}.`;

    try {
      const res = await fetch('http://localhost:3001/api/atc-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_category: leadFlight.wakeClass,
          follower_category: followingFlight.wakeClass,
          separation_nm: telemetry.separationNm,
          crosswind_kts: params.crosswindKts,
          offline_edge_mode: params.offlineEdgeMode,
        }),
      });
      if (!res.ok) throw new Error(`Advisory API returned HTTP ${res.status}`);
      const data = await res.json();
      if (
        typeof data.mode !== 'string' ||
        !Array.isArray(data.tool_trace) ||
        typeof data.recommended_lateral_offset_m !== 'number' ||
        typeof data.recommended_altitude_offset_ft !== 'number'
      ) {
        throw new Error('Advisory API returned an invalid response.');
      }
      setAgentResponse({ ...data, atc_advisory: advisoryText });
      speakAtcClearance(advisoryText);
    } catch {
      setAgentResponse({
        mode: 'LOCAL_SIMULATION_FALLBACK',
        atc_advisory: advisoryText,
        tool_trace: [
          `[PAIR] ${leadFlight.callsign} (${leadFlight.wakeClass}) vs ${followingFlight.callsign} (${followingFlight.wakeClass})`,
          `[PHYSICS] CPA=${telemetry.cpaDistanceNm} NM in ${telemetry.timeToCpaSec}s | Wake Age=${telemetry.wakeAgeSec}s | Γ=${telemetry.wakeIntensityGamma} m²/s`,
          `[ADVISORY] Suggested alternate trajectory — awaiting controller approval (${airportSpec.code} RWY ${airportSpec.runway})`,
        ],
        recommended_lateral_offset_m: hasConflict ? 50 : 0,
        recommended_altitude_offset_ft: hasConflict ? 180 : 0,
      });
      speakAtcClearance(advisoryText);
    } finally {
      setAgentLoading(false);
    }
  }, [params, telemetry, leadFlight, followingFlight, feedMode, speakAtcClearance]);

  useEffect(() => {
    if (params.autoWatchdog && telemetry.riskScore >= 65 && !agentResponse && !agentLoading) {
      triggerAtcAgent();
    }
  }, [params.autoWatchdog, telemetry.riskScore, agentResponse, agentLoading, triggerAtcAgent]);

  const handleUpdateArrivalTime = (callsign: string, newMinutes: number) => {
    if (feedMode === 'REALTIME') return;
    setAgentResponse(null);
    setFlights((prev) => prev.map((f) => (f.callsign === callsign ? { ...f, arrivalMinutes: newMinutes } : f)));
  };

  const handleReorderFlight = (index: number, direction: -1 | 1) => {
    if (feedMode === 'REALTIME') return;
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= flights.length) return;
    setAgentResponse(null);
    setFlights((prev) => {
      const copy = [...prev];
      const tempTime = copy[index].arrivalMinutes;
      copy[index] = { ...copy[index], arrivalMinutes: copy[targetIdx].arrivalMinutes };
      copy[targetIdx] = { ...copy[targetIdx], arrivalMinutes: tempTime };
      [copy[index], copy[targetIdx]] = [copy[targetIdx], copy[index]];
      return copy;
    });
  };

  const handleToggleRunway = (callsign: string) => {
    if (feedMode === 'REALTIME') return;
    const spec = AIRPORTS[params.airport];
    const rwyAlt = spec.runway.endsWith('R') ? spec.runway.replace('R', 'L') : spec.runway.replace('L', 'R');
    setAgentResponse(null);
    setFlights((prev) => prev.map((f) => (f.callsign === callsign ? { ...f, runway: f.runway === spec.runway ? rwyAlt : spec.runway } : f)));
  };

  const handleOptimizeQueue = () => {
    if (feedMode === 'REALTIME') return;
    setAgentResponse(null);
    setFlights((prev) => prev.map((f, idx) => ({ ...f, arrivalMinutes: Math.round((2.0 + idx * 2.1) * 10) / 10 })));
  };

  const handleAirportChange = (code: AirportCode) => {
    setAgentResponse(null);
    setSelectedSurfaceCallsign(null);
    setParams((current) => ({
      ...current,
      airport: code,
      leadFlightId: INITIAL_FLIGHTS[0].callsign,
      followingFlightId: INITIAL_FLIGHTS[1].callsign,
      crosswindKts: AIRPORTS[code].defaultCrosswind,
    }));
  };

  const handleVisualizeTurbulence = (aircraft: SurfaceAircraft) => {
    const simulationFlights = getSurfaceDemoFlights(aircraft.callsign);

    setSelectedSurfaceCallsign(aircraft.callsign);
    setFlights(simulationFlights);
    setFeedMode('SIM');
    setAgentResponse(null);
    setParams((current) => ({
      ...current,
      leadFlightId: aircraft.callsign,
      followingFlightId:
        simulationFlights.find((flight) => flight.callsign !== aircraft.callsign)?.callsign
          ?? aircraft.callsign,
    }));
    setActiveView('DEMO');
    setActiveScreen('DEMO');
    setViewMode('3D');
    setIsFullscreen3D(false);
    setFocusTrigger((current) => current + 1);
  };

  if (activeView === "ATC_RADAR") {
    return (
      <>

      {/* View Switcher Dropdown */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-slate-950/90 backdrop-blur border border-cyan-500/40 px-3 py-1.5 rounded-full shadow-2xl">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">Screen:</span>
        <select
          value={activeView}
          onChange={(e) => setActiveView(e.target.value as "DEMO" | "ATC_RADAR" | "KSFO_RADAR")}
          className="bg-slate-900 text-cyan-300 text-xs font-mono font-bold px-2.5 py-1 rounded-full border border-slate-700 focus:outline-none focus:border-cyan-400 cursor-pointer"
        >
          <option value="DEMO">3D Wake Demo (Digital Twin)</option>
          <option value="ATC_RADAR">ATC Radar (TRACON)</option>
          <option value="KSFO_RADAR">KSFO Surface Radar (ASDE-X)</option>
        </select>
      </div>

        <AtcRadar />
      </>
    );
  }

  if (activeView === "KSFO_RADAR") {
    return (
      <>

      {/* View Switcher Dropdown */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-slate-950/90 backdrop-blur border border-cyan-500/40 px-3 py-1.5 rounded-full shadow-2xl">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">Screen:</span>
        <select
          value={activeView}
          onChange={(e) => setActiveView(e.target.value as "DEMO" | "ATC_RADAR" | "KSFO_RADAR")}
          className="bg-slate-900 text-cyan-300 text-xs font-mono font-bold px-2.5 py-1 rounded-full border border-slate-700 focus:outline-none focus:border-cyan-400 cursor-pointer"
        >
          <option value="DEMO">3D Wake Demo (Digital Twin)</option>
          <option value="ATC_RADAR">ATC Radar (TRACON)</option>
          <option value="KSFO_RADAR">KSFO Surface Radar (ASDE-X)</option>
        </select>
      </div>

        <KsfoRadar
          airport={params.airport}
          metar={liveMetar}
          onAirportChange={handleAirportChange}
          onVisualizeTurbulence={handleVisualizeTurbulence}
        />
      </>
    );
  }

  if (activeScreen === "ATC") {
    return (
      <>

      {/* Screen Switcher Dropdown */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-slate-950/90 backdrop-blur border border-cyan-500/40 px-3 py-1.5 rounded-full shadow-2xl">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">View:</span>
        <select
          value={activeScreen}
          onChange={(e) => setActiveScreen(e.target.value as "DEMO" | "ATC" | "KSFO")}
          className="bg-slate-900 text-cyan-300 text-xs font-mono font-bold px-2.5 py-1 rounded-full border border-slate-700 focus:outline-none focus:border-cyan-400 cursor-pointer"
        >
          <option value="DEMO">3D Wake Demo</option>
          <option value="ATC">ATC Radar (TRACON)</option>
          <option value="KSFO">KSFO Surface Radar</option>
        </select>
      </div>

        <AtcRadar />
      </>
    );
  }

  if (activeScreen === "KSFO") {
    return (
      <>

      {/* Screen Switcher Dropdown */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-slate-950/90 backdrop-blur border border-cyan-500/40 px-3 py-1.5 rounded-full shadow-2xl">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">View:</span>
        <select
          value={activeScreen}
          onChange={(e) => setActiveScreen(e.target.value as "DEMO" | "ATC" | "KSFO")}
          className="bg-slate-900 text-cyan-300 text-xs font-mono font-bold px-2.5 py-1 rounded-full border border-slate-700 focus:outline-none focus:border-cyan-400 cursor-pointer"
        >
          <option value="DEMO">3D Wake Demo</option>
          <option value="ATC">ATC Radar (TRACON)</option>
          <option value="KSFO">KSFO Surface Radar</option>
        </select>
      </div>

        <KsfoRadar
          airport={params.airport}
          metar={liveMetar}
          onAirportChange={handleAirportChange}
          onVisualizeTurbulence={handleVisualizeTurbulence}
        />
      </>
    );
  }

  return (
    <>

      {/* Screen Switcher Dropdown */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-slate-950/90 backdrop-blur border border-cyan-500/40 px-3 py-1.5 rounded-full shadow-2xl">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">View:</span>
        <select
          value={activeScreen}
          onChange={(e) => setActiveScreen(e.target.value as "DEMO" | "ATC" | "KSFO")}
          className="bg-slate-900 text-cyan-300 text-xs font-mono font-bold px-2.5 py-1 rounded-full border border-slate-700 focus:outline-none focus:border-cyan-400 cursor-pointer"
        >
          <option value="DEMO">3D Wake Demo</option>
          <option value="ATC">ATC Radar (TRACON)</option>
          <option value="KSFO">KSFO Surface Radar</option>
        </select>
      </div>

    <>

      {/* View Switcher Dropdown */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-slate-950/90 backdrop-blur border border-cyan-500/40 px-3 py-1.5 rounded-full shadow-2xl">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">Screen:</span>
        <select
          value={activeView}
          onChange={(e) => setActiveView(e.target.value as "DEMO" | "ATC_RADAR" | "KSFO_RADAR")}
          className="bg-slate-900 text-cyan-300 text-xs font-mono font-bold px-2.5 py-1 rounded-full border border-slate-700 focus:outline-none focus:border-cyan-400 cursor-pointer"
        >
          <option value="DEMO">3D Wake Demo (Digital Twin)</option>
          <option value="ATC_RADAR">ATC Radar (TRACON)</option>
          <option value="KSFO_RADAR">KSFO Surface Radar (ASDE-X)</option>
        </select>
      </div>

    <div className={`min-h-screen p-3.5 font-sans flex flex-col gap-3 transition-colors ${lightMode ? 'bg-slate-100 text-slate-900' : 'bg-[#03060f] text-slate-100'}`}>
      <header className={`flex flex-wrap items-center justify-between gap-2.5 border px-4 py-2.5 rounded-xl ${lightMode ? 'bg-white border-slate-300' : 'bg-slate-900/75 border-slate-800'}`}>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-500/10 border border-cyan-500/30 rounded-lg">
            <Plane className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-extrabold tracking-wider">AERO-SONAR</h1>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                feedMode === 'REALTIME' && realtimeStatus === 'BACKEND LIVE (DEMO VALUES)'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : feedMode === 'REALTIME'
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
              }`}>
                {feedMode === 'REALTIME' ? realtimeStatus : 'SIMULATION SANDBOX'}
              </span>
            </div>
            <p className="text-[11px] font-mono text-emerald-500 truncate max-w-md">{liveMetar}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className={`flex border rounded-lg p-1 ${lightMode ? 'bg-slate-100 border-slate-300' : 'bg-slate-950 border-slate-800'}`}>
            <button
              onClick={() => { setAgentResponse(null); setFeedMode('SIM'); }}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold transition ${feedMode === 'SIM' ? 'bg-amber-500/25 text-amber-300 border border-amber-500/50' : 'text-slate-400'}`}
            >
              SIMULATION
            </button>
            <button
              onClick={() => { setAgentResponse(null); setFeedMode('REALTIME'); }}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold flex items-center gap-1 transition ${feedMode === 'REALTIME' ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-500/50' : 'text-slate-400'}`}
            >
              <Activity className="w-3 h-3" /> REAL-TIME ATC
            </button>
          </div>

          <select
            value={params.airport}
            onChange={(e) => {
              const code = e.target.value as AirportCode;
              handleAirportChange(code);
            }}
            className={`border border-cyan-500/40 text-cyan-400 text-xs font-mono font-bold px-3 py-1.5 rounded-lg outline-none ${lightMode ? 'bg-slate-50' : 'bg-slate-950'}`}
          >
            {(Object.keys(AIRPORTS) as AirportCode[]).map((code) => (
              <option key={code} value={code}>
                {code} ({AIRPORTS[code].iata}) — RWY {AIRPORTS[code].runway}
              </option>
            ))}
          </select>

          <div className={`flex border rounded-lg p-1 ${lightMode ? 'bg-slate-100 border-slate-300' : 'bg-slate-950 border-slate-800'}`}>
            <button
              onClick={() => setViewMode('3D')}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold transition ${viewMode === '3D' ? 'bg-cyan-500/25 text-cyan-400 border border-cyan-500/50' : 'text-slate-400'}`}
            >
              3D TWIN + IDS4
            </button>
            <button
              onClick={() => { setIsFullscreen3D(false); setViewMode('STARS'); }}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold transition ${viewMode === 'STARS' ? 'bg-cyan-500/25 text-cyan-400 border border-cyan-500/50' : 'text-slate-400'}`}
            >
              2D STARS RADAR
            </button>
          </div>

          {viewMode === '3D' && (
            <button
              onClick={() => setIsFullscreen3D(!isFullscreen3D)}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-mono font-bold border transition ${
                isFullscreen3D ? 'bg-cyan-500/25 border-cyan-400 text-cyan-300' : 'border-slate-700 text-slate-300 hover:border-cyan-400'
              }`}
            >
              {isFullscreen3D ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              {isFullscreen3D ? 'MINIMIZE' : 'MAXIMIZE'}
            </button>
          )}

          <button
            onClick={() => setLightMode(!lightMode)}
            className={`p-1.5 rounded-lg border transition ${lightMode ? 'bg-amber-100 border-amber-400 text-amber-700' : 'bg-slate-800 border-slate-700 text-amber-300'}`}
          >
            {lightMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </button>

          <button
            onClick={() => setParams((p) => ({ ...p, autoWatchdog: !p.autoWatchdog }))}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono font-bold border transition ${
              params.autoWatchdog ? 'bg-purple-500/25 border-purple-400 text-purple-300' : 'border-slate-700 text-slate-400'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            {params.autoWatchdog ? 'AUTO-AGENT: ON' : 'AUTO-AGENT: OFF'}
          </button>

          <button
            onClick={() => setParams((p) => ({ ...p, voiceEnabled: !p.voiceEnabled }))}
            className={`p-1.5 rounded-lg border ${params.voiceEnabled ? 'bg-purple-500/15 border-purple-500/40 text-purple-400' : 'border-slate-700 text-slate-500'}`}
          >
            {params.voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>

          <button
            onClick={() => setParams((p) => ({ ...p, isPlaying: !p.isPlaying }))}
            className="p-1.5 rounded-lg border border-slate-700 hover:border-cyan-400"
          >
            {params.isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>

          <button
            onClick={() => setParams((p) => ({ ...p, offlineEdgeMode: !p.offlineEdgeMode }))}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border ${
              params.offlineEdgeMode ? 'bg-amber-500/20 border-amber-500 text-amber-400' : 'border-slate-700 text-slate-400'
            }`}
          >
            {params.offlineEdgeMode ? <WifiOff className="w-3.5 h-3.5" /> : <Cpu className="w-3.5 h-3.5 text-cyan-400" />}
            {params.offlineEdgeMode ? 'LOCAL SIMULATION' : 'ADVISORY API'}
          </button>
        </div>
      </header>

      {viewMode === 'STARS' ? (
        <div className="flex-1 rounded-xl overflow-hidden border border-cyan-900/60">
          <StarsRadar
            metarText={liveMetar}
            qnh={weatherObservation?.altim != null ? (weatherObservation.altim / 33.8639).toFixed(2) : '—'}
          />
        </div>
      ) : isFullscreen3D ? (
        <div className="relative h-[calc(100vh-92px)] w-full">
          <AirspaceScene
            flights={flights}
            params={params}
            telemetry={telemetry}
            recommendedOffset={{
              lateralM: agentResponse?.recommended_lateral_offset_m ?? 0,
              altitudeFt: agentResponse?.recommended_altitude_offset_ft ?? 0,
            }}
            focusTrigger={focusTrigger}
            lightMode={lightMode}
            onSelectFlight={(callsign) => {
              setAgentResponse(null);
              setParams((p) => ({
                ...p,
                followingFlightId: callsign !== p.leadFlightId ? callsign : p.followingFlightId,
              }));
            }}
            onToggleHazardZones={() => setParams((p) => ({ ...p, showHazardZones: !p.showHazardZones }))}
          />

          <div className="absolute bottom-4 left-4 right-4 z-20 flex flex-wrap items-center justify-between gap-3 bg-slate-950/90 backdrop-blur border border-slate-800 px-4 py-2.5 rounded-xl font-mono text-xs">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <span className="text-[10px] text-slate-400 block">ACTIVE PAIR</span>
                <span className="font-bold text-cyan-300">{leadFlight.callsign} → {followingFlight.callsign}</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block">STATUS / RISK</span>
                <span className={`font-bold ${telemetry.riskCategory === 'CRITICAL' ? 'text-red-400' : telemetry.riskCategory === 'CAUTION' ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {telemetry.conflictLabel} ({telemetry.riskScore}%)
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block">CPA / WAKE AGE</span>
                <span className="text-white font-bold">{telemetry.cpaDistanceNm} NM • {telemetry.wakeAgeSec}s</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block">ROI SAVED</span>
                <span className="text-emerald-400 font-bold">+{telemetry.extraLandingsHr} flt/hr • {telemetry.co2SavedKgHr} kg CO₂</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button onClick={triggerAtcAgent} disabled={agentLoading} className="px-3.5 py-2 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-[11px]">
                {agentLoading ? 'ANALYZING...' : 'RUN SIMULATION ADVISORY'}
              </button>
              <button onClick={() => setIsFullscreen3D(false)} className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 font-bold text-[11px] flex items-center gap-1">
                <Minimize2 className="w-3.5 h-3.5" /> NORMAL VIEW
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
            <div className={`lg:col-span-3 border rounded-xl p-4 flex flex-col gap-3 ${lightMode ? 'bg-white border-slate-300' : 'bg-slate-900/65 border-slate-800'}`}>
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400">
                  {feedMode === 'REALTIME' ? 'Live ATC Feed Telemetry' : 'Simulation Parameters'}
                </h2>
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded font-bold ${
                  feedMode === 'REALTIME' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                }`}>
                  {feedMode === 'REALTIME' ? 'AUTO-SYNC' : 'INTERACTIVE'}
                </span>
              </div>

              <div className="space-y-2">
                <div>
                  <label className="text-[10px] font-bold uppercase text-slate-400 block mb-1">Lead / Selected Aircraft</label>
                  <select
                    value={leadFlight.callsign}
                    onChange={(e) => {
                      const newLead = e.target.value;
                      setAgentResponse(null);
                      setParams((p) => ({
                        ...p,
                        leadFlightId: newLead,
                        followingFlightId: p.followingFlightId === newLead ? flights.find((f) => f.callsign !== newLead)?.callsign || p.followingFlightId : p.followingFlightId,
                      }));
                    }}
                    className={`w-full border border-cyan-500/40 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold outline-none ${lightMode ? 'bg-slate-50 text-slate-900' : 'bg-slate-950 text-cyan-300'}`}
                  >
                    {flights.map((f) => (
                      <option key={f.callsign} value={f.callsign}>
                        {f.callsign} — {f.acType} — {f.wakeClass}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-bold uppercase text-slate-400 block mb-1">Following / Interacting Aircraft</label>
                  <select
                    value={followingFlight.callsign}
                    onChange={(e) => { setAgentResponse(null); setParams((p) => ({ ...p, followingFlightId: e.target.value })); }}
                    className={`w-full border border-emerald-500/40 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold outline-none ${lightMode ? 'bg-slate-50 text-slate-900' : 'bg-slate-950 text-emerald-300'}`}
                  >
                    {flights.filter((f) => f.callsign !== leadFlight.callsign).map((f) => (
                      <option key={f.callsign} value={f.callsign}>
                        {f.callsign} — {f.acType} — {f.wakeClass}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">Aircraft Size / Vortex Scale</span>
                  <span className="font-mono text-purple-400 font-bold">{params.aircraftScale.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  value={params.aircraftScale}
                  onChange={(e) => {
                    setAgentResponse(null);
                    setParams({ ...params, aircraftScale: parseFloat(e.target.value) });
                  }}
                  className="w-full accent-purple-400"
                />
              </div>

              {feedMode === 'SIM' ? (
                <>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-slate-400 flex items-center gap-1"><Wind className="w-3.5 h-3.5 text-cyan-400" /> Wind Speed (All-Sector)</span>
                      <span className="font-mono text-cyan-400 font-bold">{Math.abs(params.crosswindKts).toFixed(1)} kts</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={30}
                      step={0.5}
                      value={params.crosswindKts}
                      onChange={(e) => {
                        setAgentResponse(null);
                        setParams({ ...params, crosswindKts: parseFloat(e.target.value) });
                      }}
                      className="w-full accent-cyan-400"
                    />
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-slate-400">Wind Direction (180° Left ↔ Right)</span>
                      <span className="font-mono text-sky-400 font-bold">{(params.windAngleDeg ?? 90) > 0 ? `+${params.windAngleDeg ?? 90}° (R)` : (params.windAngleDeg ?? 90) < 0 ? `${params.windAngleDeg}° (L)` : "0° (HEAD)"}</span>
                    </div>
                    <input
                      type="range"
                      min={-90}
                      max={90}
                      step={5}
                      value={params.windAngleDeg ?? 90}
                      onChange={(e) => {
                        setAgentResponse(null);
                        setParams({ ...params, windAngleDeg: parseFloat(e.target.value) });
                      }}
                      className="w-full accent-sky-400"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-slate-400">CPA Separation Threshold</span>
                      <span className="font-mono text-amber-400">{params.trajectoryThresholdNm.toFixed(1)} NM</span>
                    </div>
                    <input
                      type="range"
                      min={2.0}
                      max={6.0}
                      step={0.2}
                      value={params.trajectoryThresholdNm}
                      onChange={(e) => {
                        setAgentResponse(null);
                        setParams({ ...params, trajectoryThresholdNm: parseFloat(e.target.value) });
                      }}
                      className="w-full accent-amber-400"
                    />
                  </div>
                </>
              ) : (
                <div className={`border rounded-lg p-3 space-y-1.5 text-[11px] font-mono ${lightMode ? 'bg-emerald-50 border-emerald-300' : 'bg-emerald-950/20 border-emerald-500/30'}`}>
                  <div className="flex justify-between">
                    <span className="text-slate-400">LIVE METAR X-WIND:</span>
                    <span className="text-emerald-400 font-bold">{params.crosswindKts.toFixed(1)} KTS</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">FAA/ICAO CPA LIMIT:</span>
                    <span className="text-cyan-400 font-bold">{params.trajectoryThresholdNm.toFixed(1)} NM</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">STREAM POLLING:</span>
                    <span className="text-emerald-300 font-bold">EVERY 5 SEC (AUTO)</span>
                  </div>
                </div>
              )}

              <div className={`border rounded-lg p-2.5 ${lightMode ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/90 border-slate-800/80'}`}>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Vortex Decay Γ(t)</span>
                  <span className="text-[10px] font-mono text-cyan-400">Age: {telemetry.wakeAgeSec}s</span>
                </div>
                <div className="h-20 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={telemetry.decayCurve}>
                      <XAxis dataKey="sec" tick={{ fontSize: 9, fill: '#64748b' }} tickFormatter={(v) => `${v}s`} />
                      <YAxis hide domain={[0, 650]} />
                      <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', fontSize: '11px' }} />
                      <ReferenceLine y={180} stroke="#10b981" strokeDasharray="3 3" />
                      <Area type="monotone" dataKey="strength" stroke="#38bdf8" fill="#0284c7" fillOpacity={0.25} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="mt-auto pt-2 border-t border-slate-800/60 space-y-1.5">
                <h3 className="text-[11px] font-bold uppercase tracking-widest text-emerald-400">Runway & Climate ROI</h3>
                <div className={`px-3 py-1.5 rounded-lg border flex justify-between items-center ${lightMode ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/90 border-slate-800'}`}>
                  <span className="text-xs text-slate-400">Throughput Gain</span>
                  <span className="text-xs font-bold text-emerald-400">+{telemetry.extraLandingsHr} flights/hr</span>
                </div>
                <div className={`px-3 py-1.5 rounded-lg border flex justify-between items-center ${lightMode ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/90 border-slate-800'}`}>
                  <span className="text-xs text-slate-400 flex items-center gap-1"><Leaf className="w-3.5 h-3.5 text-emerald-400" /> CO₂ Prevented</span>
                  <span className="text-xs font-bold text-emerald-400">{telemetry.co2SavedKgHr} kg/hr</span>
                </div>
                <div className={`px-3 py-1.5 rounded-lg border flex justify-between items-center ${lightMode ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/90 border-slate-800'}`}>
                  <span className="text-xs text-slate-400 flex items-center gap-1"><DollarSign className="w-3.5 h-3.5 text-cyan-400" /> Delay Cost Saved</span>
                  <span className="text-xs font-bold text-cyan-400">${telemetry.delayCostSavedUsdHr}/hr</span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-6 h-[480px]">
              <AirspaceScene
                flights={flights}
                params={params}
                telemetry={telemetry}
                recommendedOffset={{
                  lateralM: agentResponse?.recommended_lateral_offset_m ?? 0,
                  altitudeFt: agentResponse?.recommended_altitude_offset_ft ?? 0,
                }}
                focusTrigger={focusTrigger}
                lightMode={lightMode}
                onSelectFlight={(callsign) => {
                  setAgentResponse(null);
                  setParams((p) => ({
                    ...p,
                    followingFlightId: callsign !== p.leadFlightId ? callsign : p.followingFlightId,
                  }));
                }}
                onToggleHazardZones={() => setParams((p) => ({ ...p, showHazardZones: !p.showHazardZones }))}
              />
            </div>

            <div className={`lg:col-span-3 border rounded-xl p-4 flex flex-col gap-3 ${lightMode ? 'bg-white border-slate-300' : 'bg-slate-900/65 border-slate-800'}`}>
              <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400">Pair Conflict & Wake Telemetry</h2>

              <div className={`p-3 rounded-xl border transition-all ${
                telemetry.riskCategory === 'CRITICAL'
                  ? 'bg-red-950/45 border-red-500/70'
                  : telemetry.riskCategory === 'CAUTION'
                  ? 'bg-amber-950/45 border-amber-500/70'
                  : 'bg-emerald-950/35 border-emerald-500/60'
              }`}>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold flex items-center gap-1"><ShieldAlert className="w-4 h-4" /> {telemetry.conflictLabel}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-950 text-white">{telemetry.riskCategory}</span>
                </div>
                <div className="flex items-baseline justify-between mt-1">
                  <span className="text-2xl font-black font-mono">{telemetry.riskScore}%</span>
                  <span className="text-[10px] font-mono text-slate-300">{leadFlight.callsign} vs {followingFlight.callsign}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className={`p-2 rounded-lg border ${lightMode ? 'bg-slate-50 border-slate-200' : 'bg-slate-950 border-slate-800'}`}>
                  <span className="text-slate-400 text-[9px] block">A. TRAJECTORY CPA</span>
                  <span className={`font-mono font-bold ${telemetry.trajectoryConflict ? 'text-red-400' : 'text-cyan-400'}`}>
                    {telemetry.cpaDistanceNm} NM ({telemetry.timeToCpaSec}s)
                  </span>
                </div>
                <div className={`p-2 rounded-lg border ${lightMode ? 'bg-slate-50 border-slate-200' : 'bg-slate-950 border-slate-800'}`}>
                  <span className="text-slate-400 text-[9px] block">B. WAKE INTENSITY</span>
                  <span className={`font-mono font-bold ${telemetry.wakeEncounter ? 'text-amber-400' : 'text-cyan-400'}`}>
                    {telemetry.wakeIntensityGamma} m²/s ({telemetry.wakeAgeSec}s)
                  </span>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800/60 flex-1 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-purple-400 flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Simulation Advisory API</h3>
                  {agentResponse && (
                    <button onClick={() => setAgentResponse(null)} className="text-[10px] text-slate-400 hover:text-cyan-400 flex items-center gap-1">
                      <RotateCcw className="w-3 h-3" /> Reset
                    </button>
                  )}
                </div>

                <button onClick={triggerAtcAgent} disabled={agentLoading} className="w-full py-2 px-4 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-xs font-bold tracking-wide text-white shadow-lg transition disabled:opacity-50">
                  {agentLoading ? 'ANALYZING PAIR CONFLICT...' : 'ANALYZE CONFLICT & TRAJECTORY'}
                </button>

                {agentResponse ? (
                  <div className={`border rounded-lg p-2.5 space-y-1.5 text-xs overflow-y-auto flex-1 ${lightMode ? 'bg-slate-50 border-slate-200' : 'bg-slate-950 border-slate-800'}`}>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-400">{agentResponse.mode}</span>
                    <p className="leading-relaxed font-medium text-[11px]">{agentResponse.atc_advisory}</p>
                    <div className="pt-1.5 border-t border-slate-800/60 space-y-1">
                      {agentResponse.tool_trace.map((step, i) => (
                        <div key={i} className="text-[10px] font-mono text-cyan-400">→ {step}</div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="border border-dashed border-slate-700 rounded-lg p-2.5 text-[11px] text-slate-400 leading-relaxed">
                    Click above to run conflict analysis for <strong>{leadFlight.callsign}</strong> & <strong>{followingFlight.callsign}</strong>. Advisories require controller approval.
                  </div>
                )}
              </div>
            </div>
          </div>

          <TowerWorkstation
            airport={params.airport}
            flights={flights}
            matrixAnalyses={matrixAnalyses}
            selectedLeadId={leadFlight.callsign}
            selectedFollowingId={followingFlight.callsign}
            crosswindKts={params.crosswindKts}
            weather={weatherObservation}
            telemetry={telemetry}
            lightMode={lightMode}
            onUpdateArrivalTime={handleUpdateArrivalTime}
            onReorderFlight={handleReorderFlight}
            onToggleRunway={handleToggleRunway}
            onSelectPairFromMatrix={(leadId, followingId) => {
              setAgentResponse(null);
              setParams((p) => ({ ...p, leadFlightId: leadId, followingFlightId: followingId }));
              setFocusTrigger((n) => n + 1);
            }}
            onOptimizeQueue={handleOptimizeQueue}
          />
        </>
      )}
    </div>
    </>
    </>
  );
}
