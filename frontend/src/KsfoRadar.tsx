import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Wind,
  ShieldAlert,
  Radio,
  ZoomIn,
  ZoomOut,
  Eye,
  EyeOff,
  Sun,
  Moon,
  LayoutGrid,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Plane,
  Activity
} from 'lucide-react';
import {
  AIRPORTS,
  type AirportCode,
  type FlightRecord,
  type WakeCategory,
} from './physics/wakeEngine';

function isWakeCategory(value: unknown): value is WakeCategory {
  return value === 'SUPER' || value === 'HEAVY' || value === 'MEDIUM';
}

function isAirportFlight(value: unknown): value is FlightRecord {
  if (typeof value !== 'object' || value === null) return false;
  const flight = value as Record<string, unknown>;
  return (
    typeof flight.callsign === 'string' &&
    flight.callsign.length > 0 &&
    typeof flight.acType === 'string' &&
    flight.acType.length > 0 &&
    isWakeCategory(flight.wakeClass) &&
    (flight.opType === 'ARR' || flight.opType === 'DEP') &&
    typeof flight.runway === 'string' &&
    Number.isFinite(flight.arrivalMinutes) &&
    Number.isFinite(flight.speedKts) &&
    Number.isFinite(flight.icaoSepNm)
  );
}

interface LiveAircraftPosition {
  icao24: string;
  callsign: string | null;
  hasPosition: boolean;
  latitude: number;
  longitude: number;
  onGround: boolean;
  groundspeedKt: number | null;
  headingDeg: number | null;
  baroAltitudeFt: number | null;
  verticalRateFpm: number | null;
  squawk: string | null;
}

interface AircraftPositionHistory {
  onGround: boolean;
  groundspeedKt: number | null;
  seenAt: number;
}

const SFO_CENTER = { latitude: 37.6213, longitude: -122.3790 };
const SFO_MAP_UNITS_PER_NM = 760;
const SFO_RUNWAYS = [
  {
    id: '28R',
    heading: 284,
    endpoints: [[37.6285, -122.3932], [37.6135, -122.3575]],
    mapEndpoints: [[-760, -115], [720, -115]],
    mapHeading: 270,
  },
  {
    id: '28L',
    heading: 284,
    endpoints: [[37.6263, -122.3939], [37.6115, -122.3585]],
    mapEndpoints: [[-730, -25], [690, -25]],
    mapHeading: 270,
  },
  {
    id: '01L',
    heading: 10,
    endpoints: [[37.6118, -122.3832], [37.6295, -122.3712]],
    mapEndpoints: [[120, 380], [120, -540]],
    mapHeading: 0,
  },
  {
    id: '01R',
    heading: 10,
    endpoints: [[37.6110, -122.3806], [37.6315, -122.3668]],
    mapEndpoints: [[210, 450], [210, -580]],
    mapHeading: 0,
  },
] as const;
const SFO_MAP_RUNWAYS = [
  { left: -760, right: 720, top: -132, bottom: -98 },
  { left: -730, right: 690, top: -42, bottom: -8 },
  { left: 104, right: 136, top: -540, bottom: 380 },
  { left: 194, right: 226, top: -580, bottom: 450 },
] as const;
const SFO_APRON_ZONES = [
  {
    name: 'TERMINAL',
    points: [[-635, 95], [45, 95], [45, 415], [-390, 445], [-595, 365], [-635, 220]],
  },
  {
    name: 'NORTH FIELD PARKING',
    points: [[-515, -415], [-200, -415], [-200, -240], [-515, -240]],
  },
  {
    name: 'CARGO PARKING',
    points: [[-710, -320], [-545, -320], [-545, -190], [-710, -190]],
  },
  {
    name: 'SOUTHFIELD PARKING',
    points: [[335, 115], [630, 115], [630, 280], [335, 280]],
  },
] as const;

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isLiveAircraftPosition(value: unknown): value is LiveAircraftPosition {
  if (typeof value !== 'object' || value === null) return false;
  const aircraft = value as Record<string, unknown>;
  return (
    typeof aircraft.icao24 === 'string' &&
    typeof aircraft.hasPosition === 'boolean' &&
    aircraft.hasPosition &&
    typeof aircraft.onGround === 'boolean' &&
    isNullableFiniteNumber(aircraft.latitude) &&
    typeof aircraft.latitude === 'number' &&
    isNullableFiniteNumber(aircraft.longitude) &&
    typeof aircraft.longitude === 'number' &&
    isNullableFiniteNumber(aircraft.groundspeedKt) &&
    isNullableFiniteNumber(aircraft.headingDeg) &&
    isNullableFiniteNumber(aircraft.baroAltitudeFt) &&
    isNullableFiniteNumber(aircraft.verticalRateFpm) &&
    (aircraft.callsign === null || typeof aircraft.callsign === 'string') &&
    (aircraft.squawk === null || typeof aircraft.squawk === 'string')
  );
}

function toSfoLocalNm(latitude: number, longitude: number) {
  return {
    x: (longitude - SFO_CENTER.longitude) * 60 * Math.cos((SFO_CENTER.latitude * Math.PI) / 180),
    y: (latitude - SFO_CENTER.latitude) * 60,
  };
}

function projectOntoSegmentNm(
  point: { x: number; y: number },
  start: readonly [number, number],
  end: readonly [number, number]
) {
  const a = toSfoLocalNm(start[0], start[1]);
  const b = toSfoLocalNm(end[0], end[1]);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const progress = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy))
  );
  return {
    progress,
    distanceNm: Math.hypot(point.x - (a.x + progress * dx), point.y - (a.y + progress * dy)),
  };
}

function headingMatchesRunway(heading: number | null, runwayHeading: number) {
  if (heading === null) return false;
  const difference = (target: number) => Math.abs((((heading - target) % 360) + 540) % 360 - 180);
  return Math.min(difference(runwayHeading), difference((runwayHeading + 180) % 360) ) <= 30;
}

function getNearestSfoRunway(latitude: number, longitude: number, heading: number | null) {
  const point = toSfoLocalNm(latitude, longitude);
  let nearest: (typeof SFO_RUNWAYS)[number] & { distanceNm: number; progress: number } | null = null;
  for (const runway of SFO_RUNWAYS) {
    const projection = projectOntoSegmentNm(point, runway.endpoints[0], runway.endpoints[1]);
    const isAligned = headingMatchesRunway(heading, runway.heading);
    const nearestIsAligned = nearest !== null && headingMatchesRunway(heading, nearest.heading);
    if (
      !nearest ||
      projection.distanceNm < nearest.distanceNm - 0.01 ||
      (Math.abs(projection.distanceNm - nearest.distanceNm) <= 0.01 && isAligned && !nearestIsAligned)
    ) {
      nearest = { ...runway, ...projection };
    }
  }
  if (!nearest) throw new Error('No SFO runway geometry is configured.');
  return nearest;
}

function getDirectionalRunwayId(runway: { id: string; heading: number }, heading: number | null) {
  const reciprocalIds: Record<string, string> = {
    '28R': '10L',
    '28L': '10R',
    '01L': '19R',
    '01R': '19L',
  };
  if (heading === null) return runway.id;
  const difference = Math.abs((((heading - runway.heading) % 360) + 540) % 360 - 180);
  return difference <= 90 ? runway.id : reciprocalIds[runway.id] ?? runway.id;
}

function getDirectionalSfoMapHeading(
  runway: { heading: number; mapHeading: number },
  heading: number | null
) {
  if (heading === null) return runway.mapHeading;
  const difference = Math.abs((((heading - runway.heading) % 360) + 540) % 360 - 180);
  return difference <= 90 ? runway.mapHeading : (runway.mapHeading + 180) % 360;
}

function toSfoMapPosition(latitude: number, longitude: number) {
  const local = toSfoLocalNm(latitude, longitude);
  return {
    x: -151 + local.x * SFO_MAP_UNITS_PER_NM,
    y: -129 - local.y * SFO_MAP_UNITS_PER_NM,
  };
}

function toSfoRunwayMapPosition(runway: (typeof SFO_RUNWAYS)[number] & { progress: number }) {
  const [start, end] = runway.mapEndpoints;
  return {
    x: start[0] + runway.progress * (end[0] - start[0]),
    y: start[1] + runway.progress * (end[1] - start[1]),
  };
}

function isPointInPolygon(x: number, y: number, polygon: readonly (readonly [number, number])[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [currentX, currentY] = polygon[index];
    const [previousX, previousY] = polygon[previous];
    if (
      (currentY > y) !== (previousY > y) &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function getSfoApronZone(x: number, y: number) {
  return SFO_APRON_ZONES.find((zone) => isPointInPolygon(x, y, zone.points))?.name ?? null;
}

function isOnSfoMapRunway(x: number, y: number) {
  // The schematic map's runway layout differs from the geodetic runway geometry.
  return SFO_MAP_RUNWAYS.some(
    (runway) => x >= runway.left && x <= runway.right && y >= runway.top && y <= runway.bottom
  );
}

// Initial authentic KSFO surface & terminal airspace traffic aligned to KSFO schematics
const INITIAL_AIRCRAFT = [
  {
    id: 'UA-863',
    callsign: 'UAL863',
    type: 'B77W',
    airline: 'United Airlines',
    x: 780,
    y: -115,
    heading: 270,
    speed: 142,
    altitude: 320,
    status: 'SHORT FINAL RWY 28R',
    route: 'DUMBA -> ILS 28R',
    assignedRwy: '28R',
    squawk: '4211',
    dest: 'SFO',
    state: 'landing'
  },
  {
    id: 'DL-142',
    callsign: 'DAL142',
    type: 'A321',
    airline: 'Delta Air Lines',
    x: 1060,
    y: -25,
    heading: 270,
    speed: 154,
    altitude: 1450,
    status: 'FINAL ILS RWY 28L',
    route: 'AXMUL -> ILS 28L',
    assignedRwy: '28L',
    squawk: '1244',
    dest: 'SFO',
    state: 'landing'
  },
  {
    id: 'AS-312',
    callsign: 'ASA312',
    type: 'B739',
    airline: 'Alaska Airlines',
    x: 560,
    y: -152,
    heading: 180,
    speed: 0,
    altitude: 13,
    status: 'HOLD SHORT RWY 28R',
    route: 'TWY Z -> HOLD SHORT 28R',
    assignedRwy: '28R',
    squawk: '3310',
    dest: 'SEA',
    state: 'holding'
  },
  {
    id: 'WN-412',
    callsign: 'SWA412',
    type: 'B738',
    airline: 'Southwest Airlines',
    x: -290,
    y: 38,
    heading: 90,
    speed: 19,
    altitude: 13,
    status: 'TAXI VIA TWY B',
    route: 'T1 APRON -> TWY B -> 01R',
    assignedRwy: '01R',
    squawk: '2105',
    dest: 'SAN',
    state: 'taxiing'
  },
  {
    id: 'SK-332',
    callsign: 'SKW332',
    type: 'E75L',
    airline: 'SkyWest Airlines',
    x: 210,
    y: 165,
    heading: 0,
    speed: 136,
    altitude: 45,
    status: 'ROLLING TAKEOFF 01R',
    route: 'RWY 01R -> OFFSHORE DEP',
    assignedRwy: '01R',
    squawk: '5120',
    dest: 'PDX',
    state: 'takeoff'
  },
  {
    id: 'BA-287',
    callsign: 'BAW287',
    type: 'A388',
    airline: 'British Airways',
    x: -760,
    y: -260,
    heading: 286,
    speed: 238,
    altitude: 4200,
    status: 'CLIMBING GAPND SID',
    route: 'RWY 28R -> GAPND2',
    assignedRwy: '28R',
    squawk: '6142',
    dest: 'LHR',
    state: 'airborne'
  },
  {
    id: 'NH-107',
    callsign: 'ANA107',
    type: 'B77W',
    airline: 'All Nippon Airways',
    x: -545,
    y: 145,
    heading: 315,
    speed: 0,
    altitude: 13,
    status: 'GATE G4 / PUSHBACK',
    route: 'INTL TERM G4 -> TWY A',
    assignedRwy: '28R',
    squawk: '4512',
    dest: 'HND',
    state: 'parked'
  },
  {
    id: 'B6-416',
    callsign: 'JBU416',
    type: 'A321',
    airline: 'JetBlue Airways',
    x: -292,
    y: 142,
    heading: 20,
    speed: 0,
    altitude: 13,
    status: 'GATE D8 / BOARDING',
    route: 'TERM 2 D8 -> TWY A',
    assignedRwy: '01R',
    squawk: '3721',
    dest: 'JFK',
    state: 'parked'
  }
];
export type SurfaceAircraft = (typeof INITIAL_AIRCRAFT)[number] & {
  flight: FlightRecord;
  isRealData?: boolean;
};

// Color palettes for authentic FAA ASDE-X Day Scope vs Night Radar Scope
const SCOPE_THEMES = {
  day: {
    name: 'FAA ASDE-X DAY',
    water: '#164241',
    waterGrid: '#1d5250',
    shoreline: '#2a6f6c',
    land: '#8b855c',
    landSubtle: '#7f7952',
    apron: '#6d6847',
    apronBorder: '#524e35',
    terminal: '#42474f',
    terminalRoof: '#585e68',
    terminalStroke: '#1e2229',
    runwayAsphalt: '#10141a',
    runwayEdge: '#f8fafc',
    runwayMarking: '#f8fafc',
    runwayOccupied: '#ef4444',
    taxiwayAsphalt: '#1b2028',
    taxiwayCenterline: '#eab308',
    holdShort: '#facc15',
    targetFill: '#facc15',
    targetStroke: '#090d16',
    targetSelected: '#fb923c',
    tagBg: 'rgba(12, 18, 24, 0.86)',
    tagBorder: 'rgba(250, 204, 21, 0.55)',
    tagCallsign: '#facc15',
    tagMeta: '#e2e8f0',
    tagStatus: '#7dd3fc',
    labelColor: '#181a14',
    taxiLabelBg: '#10141a',
    taxiLabelText: '#facc15',
    insetBg: '#164241',
    insetBorder: '#0a0e12'
  },
  night: {
    name: 'NIGHT RADAR SCOPE',
    water: '#040b14',
    waterGrid: '#0a192c',
    shoreline: '#133152',
    land: '#0b111a',
    landSubtle: '#0e1622',
    apron: '#111a27',
    apronBorder: '#1e293b',
    terminal: '#1e293b',
    terminalRoof: '#334155',
    terminalStroke: '#475569',
    runwayAsphalt: '#070a0f',
    runwayEdge: '#cbd5e1',
    runwayMarking: '#e2e8f0',
    runwayOccupied: '#ef4444',
    taxiwayAsphalt: '#0f1622',
    taxiwayCenterline: '#ca8a04',
    holdShort: '#f59e0b',
    targetFill: '#4ade80',
    targetStroke: '#020617',
    targetSelected: '#f59e0b',
    tagBg: 'rgba(2, 6, 23, 0.88)',
    tagBorder: 'rgba(74, 222, 128, 0.45)',
    tagCallsign: '#4ade80',
    tagMeta: '#38bdf8',
    tagStatus: '#fbbf24',
    labelColor: '#64748b',
    taxiLabelBg: '#020617',
    taxiLabelText: '#eab308',
    insetBg: '#040b14',
    insetBorder: '#1e293b'
  }
};

interface KsfoRadarProps {
  airport: AirportCode;
  metar: string;
  onAirportChange: (airport: AirportCode) => void;
  onVisualizeTurbulence: (aircraft: SurfaceAircraft) => void;
}

export default function App({
  airport,
  metar,
  onAirportChange,
  onVisualizeTurbulence,
}: KsfoRadarProps) {
  const canvasRef = useRef(null);
  const aircraftRef = useRef<SurfaceAircraft[]>([]);
  const liveAircraftHistoryRef = useRef(new Map<string, AircraftPositionHistory>());
  const activeTakeoffRef = useRef(new Map<string, number>());

  // UI & Viewport states
  const [scopeMode, setScopeMode] = useState('day'); // 'day' matches the circled tower monitor
  const [hideUI, setHideUI] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [showInsets, setShowInsets] = useState(true);

  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0, moved: false });

  const [selectedId, setSelectedId] = useState('');
  const [aircraftList, setAircraftList] = useState<SurfaceAircraft[]>([]);
  const [feedStatus, setFeedStatus] = useState('SYNCING...');
  const [realDataMode, setRealDataMode] = useState(false);
  const [utcTime, setUtcTime] = useState('');

  // Keep latest reactive settings in refs for smooth 60fps Canvas loop
  const stateRef = useRef({
    scopeMode,
    zoom,
    pan,
    selectedId,
    showInsets,
    hideUI,
    panelCollapsed,
    realDataMode
  });

  useEffect(() => {
    stateRef.current = {
      scopeMode,
      zoom,
      pan,
      selectedId,
      showInsets,
      hideUI,
      panelCollapsed,
      realDataMode
    };
  }, [scopeMode, zoom, pan, selectedId, showInsets, hideUI, panelCollapsed, realDataMode]);

  // Live Zulu (UTC) clock for ATCT display
  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      const hh = String(now.getUTCHours()).padStart(2, '0');
      const mm = String(now.getUTCMinutes()).padStart(2, '0');
      const ss = String(now.getUTCSeconds()).padStart(2, '0');
      setUtcTime(`${hh}:${mm}:${ss}Z`);
    };
    updateClock();
    const timer = setInterval(updateClock, 1000);
    return () => clearInterval(timer);
  }, []);

  // Sync aircraft telemetry list to React state every 250ms for crisp sidebar updates
  useEffect(() => {
    const interval = setInterval(() => {
      setAircraftList(aircraftRef.current.map(a => ({ ...a })));
    }, 250);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;

    aircraftRef.current = [];
    setAircraftList([]);
    setSelectedId('');
    setFeedStatus(realDataMode ? 'SYNCING REAL POSITIONS...' : 'SYNCING...');
    liveAircraftHistoryRef.current.clear();
    activeTakeoffRef.current.clear();

    if (realDataMode && airport !== 'KSFO') {
      setFeedStatus('REAL DATA AVAILABLE FOR KSFO ONLY');
      return () => {
        active = false;
      };
    }

    const syncAirportFlights = async () => {
      controller?.abort();
      controller = new AbortController();

      try {
        const response = await fetch(
          `http://localhost:3001/api/live-flights?airport=${airport}`,
          { signal: controller.signal }
        );
        if (!response.ok) throw new Error(`Live flight API returned HTTP ${response.status}`);
        const data: unknown = await response.json();
        if (
          typeof data !== 'object' ||
          data === null ||
          !('flights' in data) ||
          !Array.isArray(data.flights) ||
          !('aircraft' in data) ||
          !Array.isArray(data.aircraft)
        ) {
          throw new Error('Live flight API returned an invalid response.');
        }

        const liveFlights = data.flights.filter(isAirportFlight);
        let nextAircraft: SurfaceAircraft[];

        if (realDataMode) {
          const now = Date.now();
          const nextHistory = new Map<string, AircraftPositionHistory>();
          const nextTakeoffs = new Map(activeTakeoffRef.current);
          const realTargets = data.aircraft.filter(isLiveAircraftPosition).flatMap((source, index) => {
            const localPosition = toSfoLocalNm(source.latitude, source.longitude);
            const distanceFromAirportNm = Math.hypot(localPosition.x, localPosition.y);
            if (distanceFromAirportNm > 2.5) return [];

            const previous = liveAircraftHistoryRef.current.get(source.icao24);
            const hasRecentHistory = previous !== undefined && now - previous.seenAt <= 5 * 60_000;
            const speed = source.groundspeedKt ?? 0;
            const nearestRunway = getNearestSfoRunway(
              source.latitude,
              source.longitude,
              source.headingDeg
            );
            const onGeographicRunway = nearestRunway.distanceNm <= 0.05;
            const runwayAligned = headingMatchesRunway(source.headingDeg, nearestRunway.heading);
            const directionalRunway = getDirectionalRunwayId(nearestRunway, source.headingDeg);
            const acceleratingForTakeoff =
              source.onGround &&
              onGeographicRunway &&
              runwayAligned &&
              speed >= 35 &&
              hasRecentHistory &&
              previous.onGround &&
              previous.groundspeedKt !== null &&
              speed - previous.groundspeedKt >= 5;
            const liftingOff =
              !source.onGround &&
              hasRecentHistory &&
              previous.onGround &&
              nearestRunway.distanceNm <= 0.35 &&
              runwayAligned &&
              speed >= 45 &&
              (source.baroAltitudeFt ?? Infinity) <= 600 &&
              (source.verticalRateFpm ?? 0) >= 200;

            if (acceleratingForTakeoff || liftingOff) {
              nextTakeoffs.set(source.icao24, now + 3 * 60_000);
            }
            const climbingAfterTakeoff =
              !source.onGround &&
              (nextTakeoffs.get(source.icao24) ?? 0) > now &&
              nearestRunway.distanceNm <= 1.5 &&
              runwayAligned &&
              speed >= 45 &&
              (source.baroAltitudeFt ?? Infinity) <= 800 &&
              (source.verticalRateFpm ?? 0) >= 200;
            const rawMapPosition = toSfoMapPosition(source.latitude, source.longitude);
            const mapPosition = acceleratingForTakeoff
              ? toSfoRunwayMapPosition(nearestRunway)
              : rawMapPosition;
            const onDisplayedRunway = isOnSfoMapRunway(mapPosition.x, mapPosition.y);
            const taxiing =
              source.onGround &&
              !onDisplayedRunway &&
              speed >= 3 &&
              speed <= 32;
            const apronZone = getSfoApronZone(mapPosition.x, mapPosition.y);
            const parked =
              source.onGround &&
              source.groundspeedKt !== null &&
              speed < 3 &&
              !onDisplayedRunway &&
              apronZone !== null;

            nextHistory.set(source.icao24, {
              onGround: source.onGround,
              groundspeedKt: source.groundspeedKt,
              seenAt: now,
            });
            if (!taxiing && !parked && !acceleratingForTakeoff && !liftingOff && !climbingAfterTakeoff) return [];

            const callsign = source.callsign?.trim() || source.icao24.toUpperCase();
            const aircraftType = 'UNKN';
            const runway = (acceleratingForTakeoff || liftingOff || climbingAfterTakeoff)
              ? directionalRunway
              : '—';
            const state = taxiing ? 'taxiing' : parked ? 'parked' : 'takeoff';
            const status = taxiing
              ? 'TAXIING · LIVE'
              : parked
                ? `PARKED · ${apronZone}`
                : source.onGround
                  ? `TAKEOFF ROLL RWY ${runway}`
                  : `TAKEOFF CLIMB RWY ${runway}`;
            const profile = INITIAL_AIRCRAFT[index % INITIAL_AIRCRAFT.length];
            const flightRecord: FlightRecord = {
              callsign,
              acType: aircraftType,
              wakeClass: 'MEDIUM',
              opType: 'DEP',
              runway: runway === '—' ? AIRPORTS.KSFO.runway : runway,
              arrivalMinutes: 1,
              speedKts: speed,
              icaoSepNm: 3,
            };

            return [{
              ...profile,
              id: source.icao24,
              callsign,
              type: aircraftType,
              airline: 'UNKNOWN',
              x: mapPosition.x,
              y: mapPosition.y,
              heading: acceleratingForTakeoff
                ? getDirectionalSfoMapHeading(nearestRunway, source.headingDeg)
                : source.headingDeg ?? 0,
              speed,
              altitude: source.baroAltitudeFt ?? 0,
              status,
              route: 'OPEN SKY · LIVE POSITION',
              assignedRwy: runway,
              squawk: source.squawk ?? '----',
              dest: '—',
              state,
              flight: flightRecord,
              isRealData: true,
            }];
          });
          liveAircraftHistoryRef.current = nextHistory;
          for (const [icao24, expiresAt] of nextTakeoffs) {
            if (expiresAt <= now) nextTakeoffs.delete(icao24);
          }
          activeTakeoffRef.current = nextTakeoffs;
          nextAircraft = realTargets;
        } else {
          nextAircraft = liveFlights.slice(0, INITIAL_AIRCRAFT.length).map((flight, index) => ({
            ...INITIAL_AIRCRAFT[index],
            callsign: flight.callsign,
            type: flight.acType,
            assignedRwy: flight.runway,
            speed: flight.speedKts,
            flight,
          }));
        }

        if (!active) return;
        aircraftRef.current = nextAircraft;
        setAircraftList(nextAircraft);
        setSelectedId((current) =>
          nextAircraft.some((aircraft) => aircraft.id === current)
            ? current
            : nextAircraft[0]?.id ?? ''
        );
        setFeedStatus(
          realDataMode
            ? nextAircraft.length > 0 ? 'LIVE POSITIONS' : 'NO SURFACE TRAFFIC'
            : nextAircraft.length > 0 ? 'LIVE CALLSIGNS' : 'NO LIVE AIRCRAFT'
        );
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        console.error('Airport flight request failed', error);
        aircraftRef.current = [];
        setAircraftList([]);
        setSelectedId('');
        setFeedStatus('LIVE FEED UNAVAILABLE');
      }
    };

    void syncAirportFlights();
    const interval = setInterval(syncAirportFlights, 30_000);
    return () => {
      active = false;
      controller?.abort();
      clearInterval(interval);
    };
  }, [airport, realDataMode]);

  // Helper: Draw a directional swept-wing aircraft icon at (x, y) rotated to heading
  const drawAircraftSymbol = useCallback((ctx, x, y, heading, fill, stroke, scaleFactor = 1) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((heading * Math.PI) / 180);
    ctx.scale(scaleFactor, scaleFactor);

    // Swept-wing jetliner ASDE-X target silhouette (nose pointing -Y / North at 0 deg)
    ctx.beginPath();
    ctx.moveTo(0, -13); // Nose
    ctx.lineTo(2.4, -5);
    ctx.lineTo(13, 2); // Right wingtip
    ctx.lineTo(13, 4.5);
    ctx.lineTo(2.4, 1.5);
    ctx.lineTo(2, 8.5);
    ctx.lineTo(6.5, 11.5); // Right horizontal stabilizer
    ctx.lineTo(6.5, 13.2);
    ctx.lineTo(0, 11.5);
    ctx.lineTo(-6.5, 13.2); // Left horizontal stabilizer
    ctx.lineTo(-6.5, 11.5);
    ctx.lineTo(-2, 8.5);
    ctx.lineTo(-2.4, 1.5);
    ctx.lineTo(-13, 4.5); // Left wingtip
    ctx.lineTo(-13, 2);
    ctx.lineTo(-2.4, -5);
    ctx.closePath();

    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = stroke;
    ctx.stroke();

    ctx.restore();
  }, []);

  // Core KSFO Airport Schematic Renderer (used by main scope AND live tactical insets)
  const drawKSFOSchematics = useCallback((ctx, theme, aircraftSnapshot, selectedAircraftId, detailMode = 'full') => {
    // 1. SAN FRANCISCO BAY WATER BACKGROUND
    ctx.fillStyle = theme.water;
    ctx.fillRect(-2400, -1600, 4800, 3200);

    // Subtle ASDE-X range / coordinate grid over Bay water
    if (detailMode === 'full') {
      ctx.strokeStyle = theme.waterGrid;
      ctx.lineWidth = 1;
      for (let gx = -1800; gx <= 1800; gx += 200) {
        ctx.beginPath();
        ctx.moveTo(gx, -1200);
        ctx.lineTo(gx, 1200);
        ctx.stroke();
      }
      for (let gy = -1200; gy <= 1200; gy += 200) {
        ctx.beginPath();
        ctx.moveTo(-1800, gy);
        ctx.lineTo(1800, gy);
        ctx.stroke();
      }
    }

    // 2. KSFO PENINSULA LANDMASS & ACCURATE BAY SHORELINE CONTOURS
    ctx.save();
    ctx.fillStyle = theme.land;
    ctx.strokeStyle = theme.shoreline;
    ctx.lineWidth = 5;

    ctx.beginPath();
    // Western peninsula land edge (off-screen left)
    ctx.moveTo(-1600, -1000);
    // North shoreline along Highway 101 / San Bruno / North Field
    ctx.lineTo(-560, -1000);
    ctx.lineTo(-520, -450);
    // UAL Maintenance / Superbay Northern Reclamation Shoreline
    ctx.lineTo(-220, -450);
    ctx.lineTo(-180, -340);
    // Seaplane Harbor / North Bay Inlet cutout between Maintenance Base and 19R/19L
    ctx.lineTo(65, -340);
    ctx.lineTo(75, -585);
    // Runway 19R / 19L Northern Bay Threshold Fill Peninsula
    ctx.lineTo(260, -615);
    ctx.lineTo(275, -240);
    // Northern shoreline parallel to Runway 10L/28R extending east
    ctx.lineTo(765, -160);
    ctx.lineTo(785, -135);
    // Eastern threshold embankment around 28R and 28L
    ctx.lineTo(785, -88);
    ctx.lineTo(745, -70);
    ctx.lineTo(755, -45);
    ctx.lineTo(755, 5);
    // Southeast shoreline wrapping around Southfield Taxiway Loop (S/T/U/V)
    ctx.lineTo(715, 45);
    ctx.lineTo(710, 315);
    ctx.lineTo(650, 365);
    ctx.lineTo(310, 365);
    // Runway 01R / 01L Southern Threshold Fill
    ctx.lineTo(265, 485);
    ctx.lineTo(80, 485);
    ctx.lineTo(40, 465);
    // South Basin / International Terminal Southern Shoreline
    ctx.lineTo(-420, 495);
    ctx.lineTo(-580, 620);
    ctx.lineTo(-1600, 950);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 3. APRONS, RAMPS & TAXIWAY PAVEMENT NETWORK
    ctx.save();
    ctx.fillStyle = theme.apron;
    ctx.strokeStyle = theme.apronBorder;
    ctx.lineWidth = 2;

    // West / Southwest Main Terminal & Concourses Apron
    ctx.beginPath();
    ctx.moveTo(-635, 95);
    ctx.lineTo(45, 95);
    ctx.lineTo(45, 415);
    ctx.lineTo(-390, 445);
    ctx.lineTo(-595, 365);
    ctx.lineTo(-635, 220);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // North Field / UAL Maintenance Base & North Cargo Apron
    ctx.beginPath();
    ctx.roundRect(-515, -415, 315, 175, 12);
    ctx.fill();
    ctx.stroke();

    // West Cargo / Run-Up Apron
    ctx.beginPath();
    ctx.roundRect(-710, -320, 165, 130, 10);
    ctx.fill();
    ctx.stroke();

    // Southfield Cargo / Coast Guard Apron (inside Southfield loop)
    ctx.beginPath();
    ctx.roundRect(335, 115, 295, 165, 14);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Helper to draw paved taxiway ribbons + yellow centerlines
    const drawTaxiwayPath = (points, width = 14, drawCenterline = true) => {
      if (points.length < 2) return;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Asphalt ribbon
      ctx.strokeStyle = theme.taxiwayAsphalt;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
      ctx.stroke();

      // Continuous Yellow Taxiway Centerline
      if (drawCenterline) {
        ctx.strokeStyle = theme.taxiwayCenterline;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i][0], points[i][1]);
        }
        ctx.stroke();
      }
      ctx.restore();
    };

    // Main Parallel & Perimeter Taxiways
    // Taxiway B (South parallel to 28L/10R)
    drawTaxiwayPath([[-730, 38], [690, 38]], 15);
    // Taxiway A (Terminal perimeter parallel to B, then south parallel to 01L)
    drawTaxiwayPath([[-650, 88], [55, 88], [68, 105], [68, 395], [120, 395]], 14);
    // Taxiway C (Centerline taxiway between 28R and 28L)
    drawTaxiwayPath([[-690, -70], [640, -70]], 13);
    // Taxiway Z (North parallel to 28R/10L)
    drawTaxiwayPath([[-745, -168], [710, -168]], 14);
    // Taxiway R (North Field / Maintenance parallel)
    drawTaxiwayPath([[-660, -225], [65, -225]], 13);
    // Taxiway Q (North of 28R east of 19L)
    drawTaxiwayPath([[262, -168], [262, -480], [210, -520]], 13);

    // High-speed & perpendicular runway exits connecting 28R <-> C <-> 28L <-> B <-> A
    const crossConnectors = [
      // North-to-South ladder connectors across 28R, C, 28L, B
      [[-680, -168], [-680, 38]],
      [[-540, -225], [-540, 88]],
      [[-410, -225], [-410, 88]],
      [[-270, -225], [-270, 88]],
      [[-140, -225], [-140, 88]],
      [[-25, -168], [-25, 88]],
      [[68, -168], [68, 88]],
      [[262, -168], [262, 88]],
      [[385, -168], [385, 38]],
      [[515, -168], [515, 38]],
      [[645, -168], [645, 38]],
      // High-speed angled turnoffs from 28R & 28L
      [[-190, -115], [-245, -70]],
      [[-330, -115], [-385, -70]],
      [[-460, -25], [-515, 38]],
      [[-210, -25], [-265, 38]],
      [[440, -115], [395, -70]],
      [[450, -25], [405, 38]]
    ];
    crossConnectors.forEach(pts => drawTaxiwayPath(pts, 12));

    // Iconic SFO Southfield Curved Taxiway Loop (Taxiways S, T, U, V, W)
    drawTaxiwayPath([
      [262, 38],
      [645, 38],
      [675, 65],
      [675, 295],
      [640, 328],
      [295, 328],
      [262, 295],
      [262, 38]
    ], 14);
    // Southfield Internal Cross-Taxiways (T, U, V) & 01R Threshold Connector (W)
    drawTaxiwayPath([[385, 38], [385, 328]], 12);
    drawTaxiwayPath([[495, 38], [495, 328]], 12);
    drawTaxiwayPath([[590, 38], [590, 328]], 12);
    drawTaxiwayPath([[210, 435], [262, 435], [262, 295]], 13);

    // 4. APPROACH LIGHT PIERS EXTENDING INTO SAN FRANCISCO BAY
    const drawApproachPier = (x1, y1, x2, y2, horizontal = true) => {
      ctx.save();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // White/amber approach lighting crossbars
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2;
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const t = i / (steps + 1);
        const px = x1 + (x2 - x1) * t;
        const py = y1 + (y2 - y1) * t;
        ctx.beginPath();
        if (horizontal) {
          ctx.moveTo(px, py - (i === 4 ? 14 : 7));
          ctx.lineTo(px, py + (i === 4 ? 14 : 7));
        } else {
          ctx.moveTo(px - (i === 4 ? 14 : 7), py);
          ctx.lineTo(px + (i === 4 ? 14 : 7), py);
        }
        ctx.stroke();
      }
      ctx.restore();
    };

    drawApproachPier(720, -115, 955, -115, true); // 28R Bay Approach Pier
    drawApproachPier(690, -25, 925, -25, true); // 28L Bay Approach Pier
    drawApproachPier(-760, -115, -870, -115, true); // 10L Approach Pier
    drawApproachPier(120, -540, 120, -670, false); // 19R Bay Approach Pier
    drawApproachPier(210, -580, 210, -720, false); // 19L Bay Approach Pier

    // 5. FOUR INTERSECTING KSFO RUNWAYS (10L/28R, 10R/28L, 01L/19R, 01R/19L)
    const activeRunways = new Set();
    aircraftSnapshot.forEach(ac => {
      if (['landing', 'rollout', 'takeoff', 'lineup'].includes(ac.state)) {
        activeRunways.add(ac.assignedRwy);
      }
    });

    const runways = [
      {
        id: '28R',
        altId: '10L',
        x: -760,
        y: -132,
        w: 1480,
        h: 34,
        horizontal: true,
        desigWest: '10L',
        desigEast: '28R',
        occupied: activeRunways.has('28R') || activeRunways.has('10L')
      },
      {
        id: '28L',
        altId: '10R',
        x: -730,
        y: -42,
        w: 1420,
        h: 34,
        horizontal: true,
        desigWest: '10R',
        desigEast: '28L',
        occupied: activeRunways.has('28L') || activeRunways.has('10R')
      },
      {
        id: '01L',
        altId: '19R',
        x: 104,
        y: -540,
        w: 32,
        h: 920,
        horizontal: false,
        desigNorth: '19R',
        desigSouth: '01L',
        occupied: activeRunways.has('01L') || activeRunways.has('19R')
      },
      {
        id: '01R',
        altId: '19L',
        x: 194,
        y: -580,
        w: 32,
        h: 1030,
        horizontal: false,
        desigNorth: '19L',
        desigSouth: '01R',
        occupied: activeRunways.has('01R') || activeRunways.has('19L')
      }
    ];

    // Pass A: Runway asphalt + white edge borders (or red ASDE-X occupied highlight)
    runways.forEach(r => {
      ctx.fillStyle = r.occupied ? theme.runwayOccupied : theme.runwayEdge;
      ctx.fillRect(r.x - 2.5, r.y - 2.5, r.w + 5, r.h + 5);
    });

    // Pass B: Clean interior asphalt across all 4 runways so intersections join cleanly
    runways.forEach(r => {
      ctx.fillStyle = theme.runwayAsphalt;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    });

    // Pass C: Threshold piano keys, aiming bars, centerline dashes, and runway designators
    runways.forEach(r => {
      ctx.save();
      ctx.fillStyle = theme.runwayMarking;
      ctx.strokeStyle = theme.runwayMarking;

      if (r.horizontal) {
        const cy = r.y + r.h / 2;
        // Centerline dashes
        ctx.lineWidth = 2.2;
        ctx.setLineDash([18, 16]);
        ctx.beginPath();
        ctx.moveTo(r.x + 82, cy);
        ctx.lineTo(r.x + r.w - 82, cy);
        ctx.stroke();
        ctx.setLineDash([]);

        // Threshold piano keys (both ends)
        for (let offset = -12; offset <= 12; offset += 4) {
          ctx.fillRect(r.x + 8, cy + offset - 1, 20, 2);
          ctx.fillRect(r.x + r.w - 28, cy + offset - 1, 20, 2);
        }

        // Aiming point blocks
        ctx.fillRect(r.x + 115, cy - 11, 26, 4);
        ctx.fillRect(r.x + 115, cy + 7, 26, 4);
        ctx.fillRect(r.x + r.w - 141, cy - 11, 26, 4);
        ctx.fillRect(r.x + r.w - 141, cy + 7, 26, 4);

        // Runway Numbers (10L / 28R and 10R / 28L)
        ctx.font = '900 18px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.save();
        ctx.translate(r.x + 54, cy);
        ctx.rotate(Math.PI / 2);
        ctx.fillText(r.desigWest, 0, 0);
        ctx.restore();

        ctx.save();
        ctx.translate(r.x + r.w - 54, cy);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(r.desigEast, 0, 0);
        ctx.restore();
      } else {
        const cx = r.x + r.w / 2;
        // Centerline dashes
        ctx.lineWidth = 2.2;
        ctx.setLineDash([18, 16]);
        ctx.beginPath();
        ctx.moveTo(cx, r.y + 82);
        ctx.lineTo(cx, r.y + r.h - 82);
        ctx.stroke();
        ctx.setLineDash([]);

        // Threshold piano keys (North & South ends)
        for (let offset = -11; offset <= 11; offset += 4) {
          ctx.fillRect(cx + offset - 1, r.y + 8, 2, 18);
          ctx.fillRect(cx + offset - 1, r.y + r.h - 26, 2, 18);
        }

        // Runway Numbers (19R / 01L and 19L / 01R)
        ctx.font = '900 17px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.save();
        ctx.translate(cx, r.y + 52);
        ctx.rotate(Math.PI);
        ctx.fillText(r.desigNorth, 0, 0);
        ctx.restore();

        ctx.fillText(r.desigSouth, cx, r.y + r.h - 52);
      }
      ctx.restore();
    });

    // 6. FAA YELLOW/BLACK HOLD-SHORT BARS AT KEY RUNWAY INTERSECTIONS
    const drawHoldShortBar = (x, y, horizontal = true) => {
      ctx.save();
      ctx.strokeStyle = theme.holdShort;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      if (horizontal) {
        ctx.moveTo(x - 8, y - 1.5);
        ctx.lineTo(x + 8, y - 1.5);
        ctx.moveTo(x - 8, y + 1.5);
        ctx.lineTo(x + 8, y + 1.5);
      } else {
        ctx.moveTo(x - 1.5, y - 8);
        ctx.lineTo(x - 1.5, y + 8);
        ctx.moveTo(x + 1.5, y - 8);
        ctx.lineTo(x + 1.5, y + 8);
      }
      ctx.stroke();
      ctx.restore();
    };

    // Hold-short bars north of 28R, between 28R/28L, south of 28L, and flanking 01L/01R
    [-540, -410, -270, -140, -25, 68, 262, 385, 515, 645].forEach(hx => {
      drawHoldShortBar(hx, -143, true);
      drawHoldShortBar(hx, -88, true);
      drawHoldShortBar(hx, -52, true);
      drawHoldShortBar(hx, 3, true);
    });
    [-168, -70, 38, 88].forEach(hy => {
      drawHoldShortBar(92, hy, false);
      drawHoldShortBar(148, hy, false);
      drawHoldShortBar(182, hy, false);
      drawHoldShortBar(238, hy, false);
    });

    // 7. ICONIC SFO HORSESHOE TERMINAL COMPLEX & BOARDING CONCOURSES A–G
    ctx.save();
    ctx.fillStyle = theme.terminal;
    ctx.strokeStyle = theme.terminalStroke;
    ctx.lineWidth = 2.5;

    // Main curved horseshoe terminal spine
    ctx.beginPath();
    ctx.moveTo(-495, 225);
    ctx.quadraticCurveTo(-485, 365, -355, 395);
    ctx.quadraticCurveTo(-225, 365, -220, 235);
    ctx.lineTo(-258, 240);
    ctx.quadraticCurveTo(-265, 332, -355, 355);
    ctx.quadraticCurveTo(-445, 332, -455, 225);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 7 Radiating Concourse Piers (Concourses G, F, E, D, C, B, A)
    const concourses = [
      { label: 'G', x1: -475, y1: 235, x2: -565, y2: 145, w: 18 },
      { label: 'F', x1: -435, y1: 235, x2: -465, y2: 125, w: 18 },
      { label: 'E', x1: -390, y1: 255, x2: -390, y2: 140, w: 16 },
      { label: 'D', x1: -345, y1: 265, x2: -315, y2: 145, w: 17 },
      { label: 'C', x1: -295, y1: 280, x2: -215, y2: 195, w: 17 },
      { label: 'B', x1: -265, y1: 315, x2: -165, y2: 285, w: 18 },
      { label: 'A', x1: -275, y1: 355, x2: -175, y2: 395, w: 18 }
    ];

    concourses.forEach(c => {
      const angle = Math.atan2(c.y2 - c.y1, c.x2 - c.x1);
      const len = Math.hypot(c.x2 - c.x1, c.y2 - c.y1);
      ctx.save();
      ctx.translate(c.x1, c.y1);
      ctx.rotate(angle);
      ctx.fillStyle = theme.terminalRoof;
      ctx.strokeStyle = theme.terminalStroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(0, -c.w / 2, len, c.w, 6);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      if (detailMode === 'full') {
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(c.label, (c.x1 + c.x2) / 2, (c.y1 + c.y2) / 2);
      }
    });

    // UAL Maintenance Base & Superbay Hangars (North Field)
    ctx.fillStyle = theme.terminal;
    ctx.strokeStyle = theme.terminalStroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-485, -395, 115, 72, 6);
    ctx.roundRect(-345, -395, 115, 72, 6);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 8. CRISP TAXIWAY & BUILDING IDENTIFIERS
    if (detailMode === 'full') {
      const drawTaxiBadge = (text, bx, by) => {
        ctx.save();
        ctx.fillStyle = theme.taxiLabelBg;
        ctx.strokeStyle = theme.taxiwayCenterline;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.roundRect(bx - 9, by - 8, 18, 16, 3);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = theme.taxiLabelText;
        ctx.font = '900 11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx, by + 0.5);
        ctx.restore();
      };

      drawTaxiBadge('A', -360, 88);
      drawTaxiBadge('A', 68, 225);
      drawTaxiBadge('B', -360, 38);
      drawTaxiBadge('B', 435, 38);
      drawTaxiBadge('C', -330, -70);
      drawTaxiBadge('C', 435, -70);
      drawTaxiBadge('D', -270, -142);
      drawTaxiBadge('E', -140, -142);
      drawTaxiBadge('F', -25, -142);
      drawTaxiBadge('M', 68, -142);
      drawTaxiBadge('Q', 262, -310);
      drawTaxiBadge('R', -380, -225);
      drawTaxiBadge('Z', -480, -168);
      drawTaxiBadge('Z', 480, -168);
      drawTaxiBadge('S', 675, 180);
      drawTaxiBadge('T', 385, 195);
      drawTaxiBadge('U', 495, 195);
      drawTaxiBadge('V', 590, 195);

      // Facility & Terminal Labels
      ctx.save();
      ctx.fillStyle = theme.labelColor;
      ctx.font = '900 13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('INTL TERM', -485, 345);
      ctx.fillText('T1', -215, 345);
      ctx.fillText('T2', -285, 225);
      ctx.fillText('T3', -395, 215);
      ctx.fillText('UAL MAINT / SUPERBAY', -355, -408);
      ctx.fillText('NORTH CARGO', -625, -332);
      ctx.fillText('SOUTH CARGO', 480, 295);
      ctx.fillText('SAN FRANCISCO BAY', 930, -340);
      ctx.restore();
    }

    // 9. LIVE AIRCRAFT TARGETS & ASDE-X TELEMETRY TAGS
    aircraftSnapshot.forEach(ac => {
      const isSelected = ac.id === selectedAircraftId;
      const targetColor = isSelected ? theme.targetSelected : theme.targetFill;

      // Subtle pulsing selection ring
      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = theme.targetSelected;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(ac.x, ac.y, 24, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Directional ASDE-X Aircraft Icon
      drawAircraftSymbol(
        ctx,
        ac.x,
        ac.y,
        ac.heading,
        targetColor,
        theme.targetStroke,
        detailMode === 'inset' ? 1.35 : 1.15
      );

      // Telemetry Data Block & Leader Line (Full Scope Mode)
      if (detailMode === 'full') {
        const offsetX = ac.y < -180 ? 22 : ac.x > 650 ? -168 : 22;
        const offsetY = ac.y < -180 ? 24 : -34;

        ctx.save();
        ctx.strokeStyle = targetColor;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(ac.x, ac.y);
        ctx.lineTo(ac.x + (offsetX > 0 ? 18 : -18), ac.y + (offsetY > 0 ? 18 : -18));
        ctx.stroke();

        const boxX = ac.x + offsetX;
        const boxY = ac.y + offsetY - 12;
        const boxW = 148;
        const boxH = 44;

        ctx.fillStyle = theme.tagBg;
        ctx.strokeStyle = isSelected ? theme.targetSelected : theme.tagBorder;
        ctx.lineWidth = isSelected ? 2 : 1.2;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 5);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        // Line 1: Callsign + Squawk
        ctx.fillStyle = isSelected ? theme.targetSelected : theme.tagCallsign;
        ctx.font = '900 12px monospace';
        ctx.fillText(`${ac.callsign}  ${ac.type}`, boxX + 7, boxY + 5);

        // Line 2: Altitude / Ground Speed
        const altStr =
          ac.altitude <= 20
            ? `GND ${Math.round(ac.speed)}KT`
            : `${String(Math.round(ac.altitude / 100)).padStart(3, '0')}00FT ${Math.round(ac.speed)}KT`;
        ctx.fillStyle = theme.tagMeta;
        ctx.font = 'bold 10.5px monospace';
        ctx.fillText(altStr, boxX + 7, boxY + 19);

        // Line 3: Operational Status
        ctx.fillStyle = theme.tagStatus;
        ctx.font = 'bold 10px monospace';
        ctx.fillText(ac.status, boxX + 7, boxY + 31);
        ctx.restore();
      }
    });
  }, [drawAircraftSymbol]);

  // Main 60fps Animation & Runway-Aligned Physics Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animationFrameId;
    let lastTime = performance.now();

    const stepPhysicsAndRender = (now) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      // Resize canvas cleanly to match devicePixelRatio for razor-sharp rendering
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const targetW = Math.max(1, Math.floor(rect.width * dpr));
      const targetH = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const {
        scopeMode: currentMode,
        zoom: currentZoom,
        pan: currentPan,
        selectedId: currentSelectedId,
        showInsets: insetsEnabled
      } = stateRef.current;
      const theme = SCOPE_THEMES[currentMode] || SCOPE_THEMES.day;

      // 1. Update Runway-Aligned Aircraft Physics
      aircraftRef.current = aircraftRef.current.map(ac => {
        if (ac.isRealData) return ac;

        let { x, y, heading, speed, altitude, status, state } = ac;
        const rad = (heading * Math.PI) / 180;
        const dirX = Math.sin(rad);
        const dirY = -Math.cos(rad);

        if (state === 'landing') {
          // Final approach aligned to 28R (y=-115) or 28L (y=-25)
          const targetY = ac.assignedRwy === '28L' ? -25 : -115;
          y += (targetY - y) * Math.min(1, dt * 4);
          x += dirX * (speed * 0.28) * dt;
          altitude = Math.max(13, altitude - 115 * dt);

          const thresholdX = ac.assignedRwy === '28L' ? 690 : 720;
          if (x <= thresholdX && altitude <= 25) {
            state = 'rollout';
            altitude = 13;
            status = `ROLLOUT RWY ${ac.assignedRwy}`;
          } else {
            status = `FINAL ILS RWY ${ac.assignedRwy}`;
          }
        } else if (state === 'rollout') {
          speed = Math.max(18, speed - 22 * dt);
          x += dirX * (speed * 0.28) * dt;
          status = `ROLLOUT RWY ${ac.assignedRwy}`;
          // Exit onto high-speed taxiway once slowed down, then cycle smoothly for continuous traffic
          if (x <= -280) {
            x = 1120;
            y = ac.assignedRwy === '28L' ? -25 : -115;
            heading = 270;
            speed = 148;
            altitude = 1650;
            state = 'landing';
            status = `FINAL ILS RWY ${ac.assignedRwy}`;
          }
        } else if (state === 'lineup') {
          // Taxi from hold-short bar onto Runway 28R centerline and align 270 deg
          const rwyY = ac.assignedRwy === '28L' ? -25 : -115;
          if (Math.abs(y - rwyY) > 1.5) {
            y += Math.sign(rwyY - y) * 26 * dt;
            heading = 180;
            speed = 14;
            status = `LINE UP & WAIT ${ac.assignedRwy}`;
          } else {
            y = rwyY;
            heading = 270;
            speed = 0;
            status = `LINE UP & WAIT ${ac.assignedRwy}`;
          }
        } else if (state === 'takeoff') {
          // Align to assigned runway centerline and accelerate for takeoff roll & initial climb
          if (ac.assignedRwy === '01R' || ac.assignedRwy === '01L') {
            const rwyX = ac.assignedRwy === '01R' ? 210 : 120;
            x += (rwyX - x) * Math.min(1, dt * 4);
            heading = 0;
          } else {
            const rwyY = ac.assignedRwy === '28L' ? -25 : -115;
            y += (rwyY - y) * Math.min(1, dt * 4);
            heading = 270;
          }

          speed = Math.min(235, speed + 24 * dt);
          const climbRad = (heading * Math.PI) / 180;
          x += Math.sin(climbRad) * (speed * 0.28) * dt;
          y += -Math.cos(climbRad) * (speed * 0.28) * dt;

          if (speed > 132) {
            altitude += 195 * dt;
            status = `DEPARTURE CLIMB ${ac.assignedRwy}`;
          } else {
            status = `ROLLING TAKEOFF ${ac.assignedRwy}`;
          }

          // Recycle departing flights back into sequence once well clear of airport
          if (x < -1150 || y < -820) {
            if (ac.id === 'SK-332') {
              x = 210;
              y = 385;
              heading = 0;
              speed = 35;
              altitude = 13;
              state = 'takeoff';
              status = 'ROLLING TAKEOFF 01R';
            } else {
              x = 560;
              y = -152;
              heading = 180;
              speed = 0;
              altitude = 13;
              state = 'holding';
              status = `HOLD SHORT RWY ${ac.assignedRwy}`;
            }
          }
        } else if (state === 'taxiing') {
          speed = 19;
          x += dirX * (speed * 0.65) * dt;
          y += dirY * (speed * 0.65) * dt;
          status = 'TAXI VIA TWY B';
          // Loop along Taxiway Bravo between Terminal 1 and Runway 01R hold short
          if (x >= 172) {
            x = -460;
            y = 38;
            heading = 90;
          }
        } else if (state === 'airborne') {
          x += dirX * (speed * 0.26) * dt;
          y += dirY * (speed * 0.26) * dt;
          altitude = Math.min(12000, altitude + 160 * dt);
          if (x < -1350) {
            x = -520;
            y = -185;
            altitude = 2100;
          }
        } else if (state === 'goaround') {
          heading = 270;
          speed = Math.min(220, speed + 22 * dt);
          x -= (speed * 0.28) * dt;
          altitude += 240 * dt;
          status = `GO AROUND RWY ${ac.assignedRwy}`;
          if (x < -1150) {
            x = 1080;
            y = ac.assignedRwy === '28L' ? -25 : -115;
            speed = 148;
            altitude = 1600;
            state = 'landing';
            status = `FINAL ILS RWY ${ac.assignedRwy}`;
          }
        }

        return { ...ac, x, y, heading, speed, altitude, status, state };
      });

      // 2. Render Main KSFO ASDE-X Viewport
      ctx.save();
      ctx.scale(dpr, dpr);

      const viewW = rect.width;
      const viewH = rect.height;

      // Base fit scale so entire KSFO peninsula + Bay thresholds sit centered with breathing room
      const baseScale = Math.min(viewW / 1920, viewH / 1080) * currentZoom;
      const centerX = viewW / 2 + currentPan.x;
      const centerY = viewH / 2 + currentPan.y;

      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.scale(baseScale, baseScale);
      drawKSFOSchematics(ctx, theme, aircraftRef.current, currentSelectedId, 'full');
      ctx.restore();

      // 3. Authentic SFO ASDE-X Corner Tactical Zoom Insets (matching the reference photo!)
      if (insetsEnabled && viewW > 760) {
        const drawTacticalInset = (boxX, boxY, boxW, boxH, focusX, focusY, focusZoom, title) => {
          ctx.save();
          // Outer dark border frame matching the middle monitor in the SFO tower photo
          ctx.fillStyle = theme.insetBg;
          ctx.strokeStyle = theme.insetBorder;
          ctx.lineWidth = 3.5;
          ctx.beginPath();
          ctx.rect(boxX, boxY, boxW, boxH);
          ctx.fill();
          ctx.stroke();

          // Clip interior to inset rectangle
          ctx.beginPath();
          ctx.rect(boxX + 2, boxY + 2, boxW - 4, boxH - 4);
          ctx.clip();

          ctx.translate(boxX + boxW / 2, boxY + boxH / 2);
          ctx.scale(focusZoom, focusZoom);
          ctx.translate(-focusX, -focusY);
          drawKSFOSchematics(ctx, theme, aircraftRef.current, currentSelectedId, 'inset');
          ctx.restore();

          // Crisp corner sector header tag
          ctx.save();
          ctx.fillStyle = 'rgba(10, 14, 20, 0.88)';
          ctx.fillRect(boxX + 2, boxY + 2, boxW - 4, 18);
          ctx.fillStyle = '#facc15';
          ctx.font = 'bold 10px monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(title, boxX + 8, boxY + 11);
          ctx.restore();
        };

        // Top-Left Inset: North Field / UAL Maintenance & Runway 28R Approach
        drawTacticalInset(18, 18, 250, 130, -340, -195, 0.42, 'INSET 1: NORTH FIELD / 28R');

        // Bottom-Left Inset: Terminal Horseshoe Apron & Taxiway A/B Ramp
        drawTacticalInset(18, viewH - 185, 290, 165, -365, 235, 0.48, 'INSET 2: TERMINAL RAMP / TWY A-B');

        // Bottom-Right Inset: Southfield Curved Taxiway Loop (S / T / U / V)
        drawTacticalInset(viewW - 255, viewH - 220, 235, 200, 470, 185, 0.48, 'INSET 3: SOUTHFIELD LOOP');
      }

      ctx.restore();
      animationFrameId = requestAnimationFrame(stepPhysicsAndRender);
    };

    animationFrameId = requestAnimationFrame(stepPhysicsAndRender);
    return () => cancelAnimationFrame(animationFrameId);
  }, [drawKSFOSchematics]);

  // Mouse / Touch Pan & Click-to-Select Aircraft on Canvas
  const handlePointerDown = (e) => {
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    setIsDragging(true);
    dragStartRef.current = {
      x: clientX,
      y: clientY,
      panX: pan.x,
      panY: pan.y,
      moved: false
    };
  };

  const handlePointerMove = (e) => {
    if (!isDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - dragStartRef.current.x;
    const dy = clientY - dragStartRef.current.y;
    if (Math.hypot(dx, dy) > 4) {
      dragStartRef.current.moved = true;
    }
    setPan({
      x: dragStartRef.current.panX + dx,
      y: dragStartRef.current.panY + dy
    });
  };

  const handlePointerUp = (e) => {
    setIsDragging(false);
    // If user clicked without dragging, check if they clicked an aircraft on the radar scope
    if (!dragStartRef.current.moved && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const clickX = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX) - rect.left;
      const clickY = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY) - rect.top;

      const baseScale = Math.min(rect.width / 1920, rect.height / 1080) * zoom;
      const worldX = (clickX - (rect.width / 2 + pan.x)) / baseScale;
      const worldY = (clickY - (rect.height / 2 + pan.y)) / baseScale;

      let closest = null;
      let minDist = 65 / baseScale;
      aircraftRef.current.forEach(ac => {
        const d = Math.hypot(ac.x - worldX, ac.y - worldY);
        if (d < minDist) {
          minDist = d;
          closest = ac.id;
        }
      });

      if (closest) {
        setSelectedId(closest);
      }
    }
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    setZoom(z => Math.min(3.2, Math.max(0.55, +(z * factor).toFixed(2))));
  };

  // Issue live ATC clearance commands to the selected aircraft
  const issueClearance = (command) => {
    if (!selectedId) return;
    aircraftRef.current = aircraftRef.current.map(ac => {
      if (ac.id !== selectedId) return ac;

      if (command === 'TAKEOFF') {
        return {
          ...ac,
          state: 'takeoff',
          speed: Math.max(ac.speed, 28),
          status: `CLEARED TAKEOFF ${ac.assignedRwy}`
        };
      }
      if (command === 'LINEUP') {
        return {
          ...ac,
          state: 'lineup',
          status: `LINE UP & WAIT ${ac.assignedRwy}`
        };
      }
      if (command === 'HOLD') {
        return {
          ...ac,
          state: 'holding',
          speed: 0,
          status: `HOLD SHORT RWY ${ac.assignedRwy}`
        };
      }
      if (command === 'TAXI') {
        return {
          ...ac,
          state: 'taxiing',
          heading: 90,
          speed: 19,
          y: 38,
          status: 'TAXI VIA TWY B'
        };
      }
      if (command === 'GOAROUND') {
        return {
          ...ac,
          state: 'goaround',
          speed: Math.max(ac.speed, 165),
          status: `GO AROUND RWY ${ac.assignedRwy}`
        };
      }
      return ac;
    });
    setAircraftList(aircraftRef.current.map(a => ({ ...a })));
  };

  const selectedAircraft = aircraftList.find(ac => ac.id === selectedId) || null;

  return (
    <div className="relative h-screen w-screen bg-[#0c1117] text-slate-100 font-mono select-none overflow-hidden flex">
      {/* LEFT-HAND KSFO ATCT TOWER CONTROL CONSOLE (Collapsible or Hidden for Raw Screenshot View) */}
      {!hideUI && !panelCollapsed && (
        <aside className="w-[370px] lg:w-[400px] h-full bg-[#080d16]/95 backdrop-blur-md border-r border-slate-800/90 flex flex-col p-4 z-20 shadow-2xl shrink-0">
          {/* Tower Header */}
          <div className="flex items-center justify-between pb-3.5 border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-emerald-950/90 border border-emerald-700/70">
                <Radio className="text-emerald-400 animate-pulse" size={20} />
              </div>
              <div>
                <h1 className="font-black text-sm tracking-wider text-emerald-400">
                  {airport} ATCT TOWER
                </h1>
                <p className="text-[11px] text-slate-400">
                  ASDE-X Surface Movement Radar
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <select
                aria-label="Surface radar airport"
                value={airport}
                onChange={(event) => {
                  const nextAirport = event.target.value as AirportCode;
                  if (nextAirport !== 'KSFO') setRealDataMode(false);
                  onAirportChange(nextAirport);
                }}
                className="bg-slate-900 text-emerald-300 text-[11px] font-mono font-bold px-2 py-1 rounded border border-slate-700"
              >
                {(Object.keys(AIRPORTS) as AirportCode[]).map((code) => (
                  <option key={code} value={code}>{code} ({AIRPORTS[code].iata})</option>
                ))}
              </select>
              <span className="text-[11px] bg-emerald-950 text-emerald-400 px-2.5 py-1 rounded border border-emerald-800 font-bold">
                {utcTime || 'ONLINE'}
              </span>
              <button
                onClick={() => setPanelCollapsed(true)}
                title="Collapse Console"
                className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 transition"
              >
                <ChevronLeft size={16} />
              </button>
            </div>
          </div>

          {/* METAR & Active Runway Configuration */}
          <div className="mt-3.5 p-3.5 bg-slate-900/90 border border-slate-800 rounded-xl space-y-1.5">
            <div className="flex justify-between items-center text-emerald-400 font-bold text-xs">
              <span className="flex items-center gap-1.5">
                <Wind size={15} /> METAR {airport}
              </span>
            </div>
            <p className="text-xs text-slate-200 font-bold tracking-tight">{metar}</p>
            <div className="pt-1 flex items-center justify-between text-[11px] text-amber-300 font-bold border-t border-slate-800/80">
              <span>ACTIVE RUNWAY</span>
              <span>{AIRPORTS[airport].runway}</span>
            </div>
          </div>

          <div className="mt-3 p-3 bg-slate-900/80 border border-slate-800 rounded-xl">
            <button
              type="button"
              aria-pressed={realDataMode}
              disabled={airport !== 'KSFO'}
              onClick={() => setRealDataMode((enabled) => !enabled)}
              className={`w-full py-2.5 rounded-lg border text-xs font-bold transition flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 ${
                realDataMode
                  ? 'bg-emerald-950 border-emerald-600 text-emerald-200'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-slate-100'
              }`}
            >
              <Activity size={15} />
              {realDataMode ? 'RETURN TO SIMULATION' : 'VISUALIZE REAL DATA'}
            </button>
            <p className="mt-1.5 text-[10px] text-slate-400 text-center">
              {airport === 'KSFO'
                ? 'Actual SFO positions · taxiing and confirmed takeoffs'
                : 'Real position view is available for KSFO only'}
            </p>
          </div>

          {/* Active Flights & Surface Targets List */}
          <div className="mt-3.5 flex-1 flex flex-col overflow-hidden">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-bold text-slate-300 tracking-wide">
                ACTIVE SURFACE & FINAL TARGETS
              </span>
              <span className="text-[11px] bg-amber-950/80 text-amber-300 px-2 py-0.5 rounded border border-amber-800/80 font-bold">
                {feedStatus} · {aircraftList.length} TRACKS
              </span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {aircraftList.length === 0 && (
                <p className="p-3 text-xs text-slate-400">
                  {feedStatus === 'NO SURFACE TRAFFIC'
                    ? 'No nearby aircraft are taxiing, parked on an apron, or showing confirmed takeoff activity.'
                    : feedStatus === 'REAL DATA AVAILABLE FOR KSFO ONLY'
                      ? 'Select KSFO to visualize actual surface positions.'
                      : feedStatus === 'NO LIVE AIRCRAFT'
                    ? `No live aircraft are currently available for ${airport}.`
                    : feedStatus === 'LIVE FEED UNAVAILABLE'
                      ? `Unable to load live aircraft for ${airport}.`
                      : `Loading live aircraft for ${airport}...`}
                </p>
              )}
              {aircraftList.map(ac => {
                const isSel = ac.id === selectedId;
                return (
                  <div
                    key={ac.id}
                    onClick={() => setSelectedId(ac.id)}
                    className={`p-3 rounded-xl border cursor-pointer transition-all ${
                      isSel
                        ? 'bg-slate-800/95 border-amber-400 shadow-lg'
                        : 'bg-slate-900/75 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex justify-between items-center font-bold text-xs">
                      <span className="text-amber-400 flex items-center gap-1.5">
                        <Plane size={13} /> {ac.callsign}
                      </span>
                      <span className="text-slate-300 text-[11px]">
                        {ac.type} • SQK {ac.squawk}
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="text-xs text-sky-300 font-bold">{ac.status}</span>
                      <span className="text-[11px] text-slate-400 font-bold">
                        {ac.altitude <= 20 ? `${Math.round(ac.speed)} KT` : `${Math.round(ac.altitude)} FT`}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5 truncate">{ac.route}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Selected Aircraft Tower Clearance Controls */}
          {selectedAircraft && (
            <div className="mt-3 p-3.5 bg-slate-900 border border-amber-500/80 rounded-xl space-y-2.5 shadow-xl">
              <div className="flex justify-between items-center">
                <span className="text-xs font-black text-amber-400">
                  {selectedAircraft.isRealData
                    ? `${selectedAircraft.callsign} · LIVE TRACK`
                    : `${selectedAircraft.callsign} (${selectedAircraft.assignedRwy}) CLEARANCE`}
                </span>
                <button
                  onClick={() => setSelectedId('')}
                  className="text-[10px] text-slate-300 hover:text-white font-bold px-2 py-0.5 bg-slate-800 rounded"
                >
                  DESELECT
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {!realDataMode && (
                  <>
                    <button
                      onClick={() => issueClearance('TAKEOFF')}
                      className="py-2 bg-emerald-950 hover:bg-emerald-900 border border-emerald-700 text-emerald-200 rounded-lg text-xs font-bold transition"
                    >
                      CLEARED TAKEOFF
                    </button>
                    <button
                      onClick={() => issueClearance('LINEUP')}
                      className="py-2 bg-sky-950 hover:bg-sky-900 border border-sky-700 text-sky-200 rounded-lg text-xs font-bold transition"
                    >
                      LINE UP & WAIT
                    </button>
                    <button
                      onClick={() => issueClearance('HOLD')}
                      className="py-2 bg-amber-950 hover:bg-amber-900 border border-amber-700 text-amber-200 rounded-lg text-xs font-bold transition"
                    >
                      HOLD SHORT
                    </button>
                    <button
                      onClick={() =>
                        issueClearance(
                          selectedAircraft.state === 'landing' || selectedAircraft.state === 'rollout'
                            ? 'GOAROUND'
                            : 'TAXI'
                        )
                      }
                      className="py-2 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 rounded-lg text-xs font-bold transition"
                    >
                      {selectedAircraft.state === 'landing' || selectedAircraft.state === 'rollout'
                        ? 'GO AROUND'
                        : 'TAXI TWY B'}
                    </button>
                  </>
                )}
              </div>
              <button
                onClick={() => onVisualizeTurbulence(selectedAircraft)}
                className="w-full py-2 bg-cyan-950 hover:bg-cyan-900 border border-cyan-700 text-cyan-200 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5"
              >
                <Wind size={14} /> VISUALIZE TURBULENCE
              </button>
            </div>
          )}

          {/* Scope Zoom & Reset Bar */}
          <div className="mt-3 pt-3 border-t border-slate-800 flex gap-2">
            <button
              onClick={() => setZoom(z => Math.min(3.2, +(z + 0.25).toFixed(2)))}
              className="flex-1 py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-xl text-xs font-bold transition text-sky-300 flex items-center justify-center gap-1.5"
            >
              <ZoomIn size={15} /> ZOOM IN
            </button>
            <button
              onClick={() => setZoom(z => Math.max(0.55, +(z - 0.25).toFixed(2)))}
              className="flex-1 py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-xl text-xs font-bold transition text-sky-300 flex items-center justify-center gap-1.5"
            >
              <ZoomOut size={15} /> ZOOM OUT
            </button>
            <button
              onClick={() => {
                setZoom(1.0);
                setPan({ x: 0, y: 0 });
              }}
              className="px-3 py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-xl text-xs font-bold transition text-slate-200 flex items-center justify-center"
              title="Reset Scope Center"
            >
              <RotateCcw size={15} />
            </button>
          </div>
        </aside>
      )}

      {/* Expand Console Tab when Left Panel is Collapsed */}
      {!hideUI && panelCollapsed && (
        <button
          onClick={() => setPanelCollapsed(false)}
          className="absolute top-4 left-4 z-30 flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-950/90 hover:bg-slate-900 border border-slate-700 text-emerald-400 text-xs font-bold shadow-xl backdrop-blur"
        >
          <ChevronRight size={16} /> KSFO TOWER PANEL
        </button>
      )}

      {/* FULL-SCREEN ASDE-X RADAR SCOPE VIEWPORT */}
      <main className="flex-1 relative h-full w-full overflow-hidden">
        <canvas
          ref={canvasRef}
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onTouchStart={handlePointerDown}
          onTouchMove={handlePointerMove}
          onTouchEnd={handlePointerUp}
          onWheel={handleWheel}
          className="w-full h-full block cursor-grab active:cursor-grabbing"
        />

        {/* Top-Right Scope Mode & Raw Screenshot View Controls */}
        <div className="absolute top-3.5 right-3.5 z-30 flex items-center gap-2">
          {!hideUI && (
            <>
              <button
                onClick={() => setShowInsets(s => !s)}
                className={`px-3 py-2 rounded-xl border text-xs font-bold flex items-center gap-1.5 shadow-xl backdrop-blur transition ${
                  showInsets
                    ? 'bg-slate-950/90 border-amber-500/70 text-amber-300'
                    : 'bg-slate-950/85 border-slate-700 text-slate-300 hover:text-white'
                }`}
                title="Toggle SFO ASDE-X Tactical Sector Insets"
              >
                <LayoutGrid size={14} />
                INSETS: {showInsets ? 'ON' : 'OFF'}
              </button>

              <button
                onClick={() => setScopeMode(m => (m === 'day' ? 'night' : 'day'))}
                className="px-3 py-2 rounded-xl bg-slate-950/90 hover:bg-slate-900 border border-slate-700 text-xs font-bold text-emerald-300 flex items-center gap-1.5 shadow-xl backdrop-blur transition"
                title="Switch between FAA ASDE-X Day Scope (Olive/Teal) and Night Radar"
              >
                {scopeMode === 'day' ? <Sun size={14} className="text-amber-400" /> : <Moon size={14} className="text-sky-400" />}
                {scopeMode === 'day' ? 'DAY SCOPE' : 'NIGHT SCOPE'}
              </button>
            </>
          )}

          <button
            onClick={() => setHideUI(h => !h)}
            className="px-3 py-2 rounded-xl bg-slate-950/90 hover:bg-slate-900 border border-slate-700 text-xs font-bold text-slate-100 flex items-center gap-1.5 shadow-xl backdrop-blur transition"
            title="Toggle Pure Full-Bleed ASDE-X Screen Capture Mode"
          >
            {hideUI ? <Eye size={14} className="text-emerald-400" /> : <EyeOff size={14} className="text-amber-400" />}
            {hideUI ? 'SHOW UI' : 'SCOPE ONLY'}
          </button>
        </div>

        {/* Bottom Center ASDE-X Workstation Identifier Banner */}
        {!hideUI && (
          <div className="absolute bottom-3.5 left-1/2 -translate-x-1/2 bg-slate-950/90 backdrop-blur border border-slate-800 px-5 py-2 rounded-full text-[11px] font-bold text-slate-200 tracking-wider pointer-events-none shadow-2xl flex items-center gap-2 whitespace-nowrap">
            <ShieldAlert size={14} className="text-amber-400 shrink-0" />
            <span>KSFO ASDE-X // RWY 10L/28R • 10R/28L • 01L/19R • 01R/19L</span>
          </div>
        )}
      </main>
    </div>
  );
}