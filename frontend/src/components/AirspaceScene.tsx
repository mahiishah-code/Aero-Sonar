import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Line, Html } from '@react-three/drei';
import * as THREE from 'three';
import { AIRPORTS, getFlightState3D, SPECS, type FlightRecord, type SimulationParams, type WakeTelemetry } from '../physics/wakeEngine';
import { createScaledAircraftState, leadAircraftState } from '../core/simulationState.js';

interface Props {
  flights: FlightRecord[];
  params: SimulationParams;
  telemetry: WakeTelemetry;
  recommendedOffset: { lateralM: number; altitudeFt: number };
  focusTrigger: number;
  lightMode: boolean;
  onSelectFlight: (callsign: string) => void;
  onToggleHazardZones: () => void;
}

type CameraPreset = 'TOWER' | 'CHASE' | 'RADAR' | 'FOCUS';

function CameraController({ preset, encounterPoint }: { preset: CameraPreset; encounterPoint: [number, number, number] }) {
  const { camera } = useThree();
  const targetPos = useMemo(() => {
    if (preset === 'FOCUS') return new THREE.Vector3(encounterPoint[0] + 6.5, encounterPoint[1] + 4.2, encounterPoint[2] + 7.5);
    if (preset === 'CHASE') return new THREE.Vector3(3.4, 4.5, 13.0);
    if (preset === 'RADAR') return new THREE.Vector3(0.01, 25, 1.5);
    return new THREE.Vector3(12.5, 7.8, 12.5);
  }, [preset, encounterPoint]);

  useFrame(() => {
    camera.position.lerp(targetPos, 0.06);
  });
  return null;
}

function WindParticles({ signedCrosswindKts, headwindKts, isPlaying }: { signedCrosswindKts: number; headwindKts: number; isPlaying: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const streaks = useMemo(() => Array.from({ length: 22 }, (_, i) => ({
    x: ((i * 7) % 24) - 12,
    y: 0.6 + ((i * 3) % 5) * 0.85,
    z: -15 + ((i * 5) % 26),
    len: 0.65 + (i % 3) * 0.35,
  })), []);

  useFrame((_, delta) => {
    if (!groupRef.current || !isPlaying) return;
    const vx = (signedCrosswindKts / 25) * 10.5;
    const vz = (headwindKts / 25) * 7.5;
    groupRef.current.children.forEach((child) => {
      child.position.x += vx * delta;
      child.position.z += vz * delta;
      if (child.position.x > 12) child.position.x = -12;
      if (child.position.x < -12) child.position.x = 12;
      if (child.position.z > 14) child.position.z = -18;
      if (child.position.z < -18) child.position.z = 14;
    });
  });

  if (Math.hypot(signedCrosswindKts, headwindKts) <= 0.2) return null;
  const angleY = Math.atan2(signedCrosswindKts, headwindKts);

  return (
    <group ref={groupRef}>
      {streaks.map((s, idx) => (
        <mesh key={idx} position={[s.x, s.y, s.z]} rotation={[0, angleY, 0]}>
          <boxGeometry args={[0.015, 0.015, s.len]} />
          <meshBasicMaterial color="#38bdf8" transparent opacity={0.42} />
        </mesh>
      ))}
    </group>
  );
}

const WAKE_PARTICLE_COUNT = 4000;
const METERS_TO_SCENE_UNITS = 0.05;
const WAKE_DECAY_TAU_SEC = 45;
const WAKE_WIND_STRETCH_AGE_SEC = 8;
const AIR_DENSITY_KG_M3 = 1.225;

function burnhamHallockVelocity(gamma: number, coreRadius: number, radius: number) {
  if (radius < 0.01) return 0;
  return (gamma / (2 * Math.PI * radius)) * ((radius * radius) / (radius * radius + coreRadius * coreRadius));
}

function WakeParticleField({
  leadFlight,
  leadPosition,
  telemetry,
  aircraftScale,
  ambientCrosswindY,
  ambientWindAlongRunway,
  trailLength,
  isPlaying,
}: {
  leadFlight: FlightRecord;
  leadPosition: [number, number, number];
  telemetry: WakeTelemetry;
  aircraftScale: number;
  ambientCrosswindY: number;
  ambientWindAlongRunway: number;
  trailLength: number;
  isPlaying: boolean;
}) {
  const { geometry, positions, colors } = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(WAKE_PARTICLE_COUNT * 3);
    const colors = new Float32Array(WAKE_PARTICLE_COUNT * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return { geometry, positions, colors };
  }, []);
  const particles = useMemo(
    () =>
      Array.from({ length: WAKE_PARTICLE_COUNT }, (_, index) => {
        const random = (salt: number) => {
          const value = Math.sin((index + 1) * 127.1 + salt * 311.7) * 43758.5453;
          return value - Math.floor(value);
        };
        return {
          side: index % 2 === 0 ? -1 : 1,
          trailFraction: random(1),
          radiusScale: 0.25 + random(2) * 4.5,
          phase: random(3) * Math.PI * 2,
        };
      }),
    []
  );
  const phases = useRef(particles.map((particle) => particle.phase));
  const positionsRef = useRef(positions);
  const colorsRef = useRef(colors);
  const geometryRef = useRef(geometry);
  const leadSpec = SPECS[leadFlight.wakeClass];
  const aircraft = createScaledAircraftState(
    {
      ...leadAircraftState,
      mass: leadSpec.mass,
      wingspan: leadSpec.span,
      takeoffSpeed: leadSpec.speed,
    },
    aircraftScale,
    ambientCrosswindY
  );
  const b0 = (Math.PI / 4) * aircraft.wingspan;
  const coreRadius = 0.04 * aircraft.wingspan;
  const gamma0 =
    (aircraft.mass * 9.80665) /
    (AIR_DENSITY_KG_M3 * aircraft.takeoffSpeed * b0);
  const wakeAge = Math.max(1, telemetry.wakeAgeSec);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const windAge = Math.min(wakeAge, WAKE_WIND_STRETCH_AGE_SEC);

    for (let i = 0; i < WAKE_PARTICLE_COUNT; i++) {
      const particle = particles[i];
      const age = particle.trailFraction * wakeAge;
      const gamma = gamma0 * Math.exp(-age / WAKE_DECAY_TAU_SEC);
      const sinkDistance =
        (gamma0 * WAKE_DECAY_TAU_SEC * (1 - Math.exp(-age / WAKE_DECAY_TAU_SEC))) /
        (2 * Math.PI * b0);
      const centeredWindAge = particle.trailFraction * windAge - windAge / 2;
      const crosswindOffsetM = aircraft.ambientCrosswindY * centeredWindAge;
      const runwayOffsetM = ambientWindAlongRunway * centeredWindAge;
      const leftCoreX =
        leadPosition[0] - (b0 / 2) * METERS_TO_SCENE_UNITS + crosswindOffsetM * METERS_TO_SCENE_UNITS;
      const rightCoreX =
        leadPosition[0] + (b0 / 2) * METERS_TO_SCENE_UNITS + crosswindOffsetM * METERS_TO_SCENE_UNITS;
      const coreX = particle.side < 0 ? leftCoreX : rightCoreX;
      const coreY = Math.max(0.25, leadPosition[1] - sinkDistance * METERS_TO_SCENE_UNITS);
      const radius = coreRadius * particle.radiusScale;
      const tangentialSpeed = burnhamHallockVelocity(gamma, coreRadius, radius);
      const angularSpeed = tangentialSpeed / radius;
      const phase = phases.current[i] + (isPlaying ? -particle.side * angularSpeed * dt : 0);
      phases.current[i] = phase % (Math.PI * 2);

      const x = coreX + Math.cos(phase) * radius * METERS_TO_SCENE_UNITS;
      const y = coreY + Math.sin(phase) * radius * METERS_TO_SCENE_UNITS;
      const z =
        leadPosition[2] +
        particle.trailFraction * trailLength +
        runwayOffsetM * METERS_TO_SCENE_UNITS;
      const index = i * 3;
      positionsRef.current[index] = x;
      positionsRef.current[index + 1] = y;
      positionsRef.current[index + 2] = z;

      const dyL = (x - leftCoreX) / METERS_TO_SCENE_UNITS;
      const dzL = (y - coreY) / METERS_TO_SCENE_UNITS;
      const rL = Math.hypot(dyL, dzL);
      const vL = burnhamHallockVelocity(gamma, coreRadius, rL);
      const vxL = rL > 0.01 ? -vL * (dzL / rL) : 0;
      const vyL = rL > 0.01 ? vL * (dyL / rL) : 0;

      const dyR = (x - rightCoreX) / METERS_TO_SCENE_UNITS;
      const dzR = (y - coreY) / METERS_TO_SCENE_UNITS;
      const rR = Math.hypot(dyR, dzR);
      const vR = burnhamHallockVelocity(gamma, coreRadius, rR);
      const vxR = rR > 0.01 ? vR * (dzR / rR) : 0;
      const vyR = rR > 0.01 ? -vR * (dyR / rR) : 0;
      const speed = Math.hypot(vxL + vxR, vyL + vyR);

      if (speed > 10) {
        colorsRef.current[index] = 1;
        colorsRef.current[index + 1] = 0.15;
        colorsRef.current[index + 2] = 0.1;
      } else if (speed > 4) {
        colorsRef.current[index] = 1;
        colorsRef.current[index + 1] = 0.85;
        colorsRef.current[index + 2] = 0;
      } else {
        colorsRef.current[index] = 0.1;
        colorsRef.current[index + 1] = 0.5;
        colorsRef.current[index + 2] = 1;
      }
    }

    geometryRef.current.attributes.position.needsUpdate = true;
    geometryRef.current.attributes.color.needsUpdate = true;
  });

  return (
    <points geometry={geometry} frustumCulled={false}>
      <pointsMaterial
        size={0.09}
        vertexColors
        transparent
        opacity={0.85}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function AircraftMesh({
  position,
  scale = 1,
  primaryColor,
  secondaryColor,
  isQuadEngine,
  isSelected,
  isConflict,
  bankAngle = 0,
  onClick,
}: {
  position: [number, number, number];
  scale?: number;
  primaryColor: string;
  secondaryColor: string;
  isQuadEngine: boolean;
  isSelected: boolean;
  isConflict: boolean;
  bankAngle?: number;
  onClick: () => void;
}) {
  const ringRef = useRef<THREE.Mesh>(null);

  // Vertex-painted sculpted fuselage: subtle stripes painted directly into the mesh geometry (zero external pipes)
  const fuselageGeo = useMemo(() => {
    const pts = [
      new THREE.Vector2(0.001, -1.72),
      new THREE.Vector2(0.085, -1.58),
      new THREE.Vector2(0.155, -1.36),
      new THREE.Vector2(0.19, -1.04),
      new THREE.Vector2(0.195, 0.45),
      new THREE.Vector2(0.155, 1.08),
      new THREE.Vector2(0.075, 1.50),
      new THREE.Vector2(0.02, 1.68),
    ];
    const geo = new THREE.LatheGeometry(pts, 48);
    const posAttr = geo.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);

    const white = new THREE.Color('#f8fafc');
    const belly = new THREE.Color('#cbd5e1');
    const c1 = new THREE.Color(primaryColor);
    const c2 = new THREE.Color(secondaryColor);

    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i); // Vertical axis after Math.PI/2 X-rotation
      const y = posAttr.getY(i); // Longitudinal axis (-1.72 nose to +1.68 tail)
      let col = white;

      // Subtle belly tone
      if (x < -0.05) col = belly;

      // Subtle cheatline stripes painted directly on fuselage sides between nose & tail
      if (y > -1.05 && y < 1.15) {
        if (x >= 0.005 && x <= 0.032) col = c1;
        else if (x >= -0.015 && x < 0.005) col = c2;
      }

      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [primaryColor, secondaryColor]);

  const tailFinGeo = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0.56, 0);
    shape.lineTo(0.76, 0.54);
    shape.lineTo(0.52, 0.54);
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, {
      depth: 0.026,
      bevelEnabled: true,
      bevelThickness: 0.005,
      bevelSize: 0.005,
      bevelSegments: 2,
    });
  }, []);

  const wingGeo = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.32);
    shape.lineTo(2.08, 0.42);
    shape.lineTo(2.08, 0.56);
    shape.lineTo(0, 0.24);
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, {
      depth: 0.022,
      bevelEnabled: true,
      bevelThickness: 0.005,
      bevelSize: 0.005,
      bevelSegments: 2,
    });
  }, []);

  useFrame(({ clock }) => {
    if (ringRef.current) {
      const s = 1 + Math.sin(clock.getElapsedTime() * 4.5) * 0.06;
      ringRef.current.scale.set(s, s, s);
    }
  });

  const engineOffsets = isQuadEngine ? [-0.62, -1.18, 0.62, 1.18] : [-0.66, 0.66];

  return (
    <group
      position={position}
      scale={scale}
      rotation={[0, 0, bankAngle]}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {/* Single Seamless Vertex-Painted Airliner Fuselage */}
      <mesh geometry={fuselageGeo} rotation={[Math.PI / 2, 0, 0]}>
        <meshStandardMaterial vertexColors metalness={0.22} roughness={0.24} />
      </mesh>

      {/* Subtle Sapphire Cockpit Windshield */}
      <mesh position={[0, 0.088, -1.30]} rotation={[0.48, 0, 0]}>
        <cylinderGeometry args={[0.146, 0.166, 0.13, 24, 1, false, -Math.PI * 0.35, Math.PI * 0.70]} />
        <meshStandardMaterial color="#1e3a8a" metalness={0.85} roughness={0.12} />
      </mesh>

      {/* Swept Right & Left Silver-White Airfoil Wings */}
      <mesh geometry={wingGeo} position={[0.14, -0.04, -0.05]} rotation={[Math.PI / 2, 0, 0]}>
        <meshStandardMaterial color="#e2e8f0" metalness={0.35} roughness={0.28} />
      </mesh>
      <mesh geometry={wingGeo} position={[-0.14, -0.04, -0.05]} rotation={[Math.PI / 2, Math.PI, 0]}>
        <meshStandardMaterial color="#e2e8f0" metalness={0.35} roughness={0.28} />
      </mesh>

      {/* Subtle Painted Blended Winglets */}
      <mesh position={[2.19, 0.07, 0.44]} rotation={[0.15, 0, -0.35]}>
        <boxGeometry args={[0.022, 0.22, 0.11]} />
        <meshStandardMaterial color={primaryColor} />
      </mesh>
      <mesh position={[-2.19, 0.07, 0.44]} rotation={[0.15, 0, 0.35]}>
        <boxGeometry args={[0.022, 0.22, 0.11]} />
        <meshStandardMaterial color={primaryColor} />
      </mesh>

      {/* White Turbofan Nacelles with Subtle Gold Trim Rings */}
      {engineOffsets.map((engX, idx) => {
        const zSweep = Math.abs(engX) * 0.26 - 0.18;
        return (
          <group key={idx} position={[engX, -0.14, zSweep]}>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.09, 0.08, 0.44, 20]} />
              <meshStandardMaterial color="#f8fafc" metalness={0.35} roughness={0.22} />
            </mesh>
            <mesh position={[0, 0, -0.225]} rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.086, 0.01, 10, 24]} />
              <meshStandardMaterial color={secondaryColor} metalness={0.8} roughness={0.18} />
            </mesh>
            <mesh position={[0, 0, -0.21]}>
              <circleGeometry args={[0.078, 16]} />
              <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.25} />
            </mesh>
          </group>
        );
      })}

      {/* Sleek Swept Vertical Tail Fin */}
      <mesh geometry={tailFinGeo} position={[-0.013, 0.06, 0.92]} rotation={[0, -Math.PI / 2, 0]}>
        <meshStandardMaterial color={primaryColor} metalness={0.25} roughness={0.28} />
      </mesh>

      {/* Horizontal Tail Stabilizers */}
      <mesh position={[0.42, 0.04, 1.38]} rotation={[0, -0.35, 0]}>
        <boxGeometry args={[0.74, 0.02, 0.2]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.35} roughness={0.3} />
      </mesh>
      <mesh position={[-0.42, 0.04, 1.38]} rotation={[0, 0.35, 0]}>
        <boxGeometry args={[0.74, 0.02, 0.2]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.35} roughness={0.3} />
      </mesh>

      {/* Selection / Conflict Ring */}
      {(isSelected || isConflict) && (
        <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.35, 0.024, 10, 48]} />
          <meshBasicMaterial color={isConflict ? '#ef4444' : '#38bdf8'} transparent opacity={0.65} />
        </mesh>
      )}
    </group>
  );
}

function AnimatedAirspace({
  flights,
  params,
  telemetry,
  recommendedOffset,
  onSelectFlight,
}: Omit<Props, 'focusTrigger' | 'lightMode' | 'onToggleHazardZones'>) {
  const [simTick, setSimTick] = useState(0);
  const airportSpec = AIRPORTS[params.airport];

  useFrame((_, delta) => {
    if (params.isPlaying) {
      setSimTick((prev) => (prev + delta * 0.6) % 4);
    }
  });

  const leadFlight = flights.find((f) => f.callsign === params.leadFlightId) || flights[0];
  const followingFlight = flights.find((f) => f.callsign === params.followingFlightId) || flights[1];
  const visibleFlights = [leadFlight];

  const leadPos = useMemo(() => {
    const base = getFlightState3D(leadFlight, airportSpec.runway);
    return [0, base.y, base.z - simTick] as [number, number, number];
  }, [leadFlight, airportSpec.runway, simTick]);

  const wakeTrailLength = Math.min(5.2, Math.max(2.8, telemetry.separationNm * 1.1));
  const windAngleRad = ((params.windAngleDeg ?? 90) * Math.PI) / 180;
  const windSpeedMps = params.crosswindKts * 0.514444;
  const ambientCrosswindY = windSpeedMps * Math.sin(windAngleRad);
  const ambientWindAlongRunway = windSpeedMps * Math.cos(windAngleRad);

  const { leftPoints, rightPoints } = useMemo(() => {
    const lPts: [number, number, number][] = [];
    const rPts: [number, number, number][] = [];
    const segments = 28;

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const z = leadPos[2] + 1.5 + t * wakeTrailLength;
      const driftX = (telemetry.lateralDriftM / 18) * t;
      const sinkY = leadPos[1] - (telemetry.verticalSinkM / 30) * t - t * 0.25;
      const swirl = Math.sin(t * 16) * (0.04 + t * 0.12);
      const swirlY = Math.cos(t * 16) * (0.04 + t * 0.12);

      lPts.push([leadPos[0] - 0.85 + driftX + swirl, Math.max(0.2, sinkY + swirlY), z]);
      rPts.push([leadPos[0] + 0.85 + driftX - swirl, Math.max(0.2, sinkY - swirlY), z]);
    }
    return { leftPoints: lPts, rightPoints: rPts };
  }, [leadPos, wakeTrailLength, telemetry.lateralDriftM, telemetry.verticalSinkM]);

  const hazardColor =
    telemetry.riskCategory === 'CRITICAL'
      ? '#ef4444'
      : telemetry.riskCategory === 'CAUTION'
      ? '#f59e0b'
      : '#38bdf8';

  const isOffsetActive = recommendedOffset.lateralM > 0 || recommendedOffset.altitudeFt > 0;
  const hasConflict = telemetry.riskCategory === 'CRITICAL' || telemetry.riskCategory === 'CAUTION';
  const upwindSign = telemetry.lateralDriftM >= 0 ? -1 : 1;

  return (
    <group>
      {visibleFlights.map((flight) => {
        const base = getFlightState3D(flight, airportSpec.runway);
        const isLead = flight.callsign === leadFlight.callsign;
        const isFollowing = flight.callsign === followingFlight.callsign;
        const isSelected = isLead || isFollowing;

        const offsetX = isFollowing ? upwindSign * (recommendedOffset.lateralM / 14) : 0;
        const offsetY = isFollowing ? recommendedOffset.altitudeFt / 220 : 0;

        const pos: [number, number, number] = [
          isLead ? 0 : base.x + offsetX,
          base.y + offsetY,
          base.z - simTick,
        ];

        const baseScale = flight.wakeClass === 'SUPER' ? 1.15 : flight.wakeClass === 'HEAVY' ? 0.98 : 0.82;
        const scale = baseScale * (params.aircraftScale ?? 1.0);

        const primaryColor =
          isSelected && hasConflict
            ? '#dc2626'
            : isLead
            ? '#2563eb'
            : isFollowing
            ? '#059669'
            : flight.wakeClass === 'HEAVY'
            ? '#d97706'
            : '#0284c7';

        const secondaryColor = '#eab308';

        const pathEnd: [number, number, number] =
          flight.opType === 'DEP'
            ? [pos[0], pos[1] + 2.5, pos[2] - 12]
            : [pos[0], 0.15, -14];

        return (
          <group key={flight.callsign}>
            <AircraftMesh
              position={pos}
              scale={scale}
              primaryColor={primaryColor}
              secondaryColor={secondaryColor}
              isQuadEngine={flight.wakeClass === 'SUPER'}
              isSelected={isSelected}
              isConflict={isSelected && hasConflict}
              bankAngle={isFollowing && isOffsetActive ? upwindSign * -0.14 : 0}
              onClick={() => onSelectFlight(flight.callsign)}
            />

            <Html position={[pos[0], pos[1] + 1.15 * scale, pos[2]]} center>
              <button
                onClick={() => onSelectFlight(flight.callsign)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono border shadow whitespace-nowrap transition ${
                  isSelected && hasConflict
                    ? 'bg-red-950/95 text-red-200 border-red-500 font-bold'
                    : isLead
                    ? 'bg-slate-900/95 text-sky-300 border-sky-400/80 font-bold'
                    : isFollowing
                    ? 'bg-slate-900/95 text-emerald-300 border-emerald-400/80 font-bold'
                    : 'bg-slate-900/90 text-amber-200 border-amber-400/60'
                }`}
              >
                {flight.callsign} • {flight.acType} • +{flight.arrivalMinutes.toFixed(1)}m
              </button>
            </Html>

            <Line
              points={[pos, pathEnd]}
              color={isLead ? '#38bdf8' : isFollowing ? '#10b981' : '#60a5fa'}
              lineWidth={isSelected ? 1.5 : 0.8}
              dashed
              dashSize={0.5}
              gapSize={0.4}
              transparent
              opacity={0.55}
            />
          </group>
        );
      })}

      {/* Physically-scaled vortex particles trail the lead aircraft */}
      {params.showHazardZones && (
        <WakeParticleField
          leadFlight={leadFlight}
          leadPosition={leadPos}
          telemetry={telemetry}
          aircraftScale={params.aircraftScale}
          ambientCrosswindY={ambientCrosswindY}
          ambientWindAlongRunway={ambientWindAlongRunway}
          trailLength={wakeTrailLength}
          isPlaying={params.isPlaying}
        />
      )}
      {params.showHazardZones && (
        <>
          <Line points={leftPoints} color={hazardColor} lineWidth={2.2} transparent opacity={0.55} />
          <Line points={rightPoints} color={hazardColor} lineWidth={2.2} transparent opacity={0.55} />
        </>
      )}

      {hasConflict && (
        <group position={[telemetry.encounterPoint3D[0], telemetry.encounterPoint3D[1], telemetry.encounterPoint3D[2] - simTick]}>
          <mesh>
            <sphereGeometry args={[0.28, 16, 16]} />
            <meshBasicMaterial color="#ef4444" transparent opacity={0.75} />
          </mesh>
          <Html position={[0, 0.65, 0]} center>
            <div className="px-2 py-0.5 rounded bg-red-950/95 border border-red-500 text-[9px] font-mono text-red-200 whitespace-nowrap">
              PREDICTED CPA: {telemetry.cpaDistanceNm} NM ({telemetry.timeToCpaSec}s)
            </div>
          </Html>
        </group>
      )}
    </group>
  );
}

export default function AirspaceScene({
  flights,
  params,
  telemetry,
  recommendedOffset,
  focusTrigger,
  lightMode,
  onSelectFlight,
  onToggleHazardZones,
}: Props) {
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('TOWER');
  const airportSpec = AIRPORTS[params.airport];

  React.useEffect(() => {
    if (focusTrigger > 0) setCameraPreset('FOCUS');
  }, [focusTrigger]);

  const angleRad = ((params.windAngleDeg ?? 90) * Math.PI) / 180;
  const signedCrosswindKts = Math.round(params.crosswindKts * Math.sin(angleRad) * 10) / 10;
  const headwindKts = Math.round(params.crosswindKts * Math.cos(angleRad) * 10) / 10;

  return (
    <div className={`w-full h-full rounded-xl overflow-hidden border relative ${lightMode ? 'bg-slate-200 border-slate-300' : 'bg-[#040812] border-slate-800'}`}>
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-1.5 bg-slate-950/85 backdrop-blur border border-slate-800 p-1 rounded-lg">
        {(['TOWER', 'CHASE', 'RADAR', 'FOCUS'] as const).map((view) => (
          <button
            key={view}
            onClick={() => setCameraPreset(view)}
            className={`px-2 py-1 text-[10px] font-mono font-bold rounded transition ${
              cameraPreset === view ? 'bg-cyan-500/25 text-cyan-300 border border-cyan-500/50' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {view}
          </button>
        ))}
        <button
          onClick={onToggleHazardZones}
          className={`px-2 py-1 text-[10px] font-mono font-bold rounded border transition ${
            params.showHazardZones ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' : 'text-slate-400 border-slate-700'
          }`}
        >
          HAZARD ZONES: {params.showHazardZones ? 'ON' : 'OFF'}
        </button>
      </div>

      <div className="absolute top-3 right-3 z-10 flex items-center gap-2 bg-slate-950/85 backdrop-blur border border-slate-800 px-3 py-1.5 rounded-lg text-[11px] font-mono">
        <span className="text-amber-300 font-bold">{airportSpec.code} RWY {airportSpec.runway}</span>
        <span className="text-slate-600">|</span>
        <span className="text-cyan-300">
          X-WIND: {Math.abs(signedCrosswindKts).toFixed(1)}KT {signedCrosswindKts > 0.2 ? '→ (R)' : signedCrosswindKts < -0.2 ? '← (L)' : ''}
        </span>
      </div>

      <div className="absolute bottom-3 left-3 z-10 rounded-lg border border-slate-800 bg-slate-950/85 px-3 py-2 text-[10px] font-mono text-slate-300 backdrop-blur">
        <div className="mb-1 font-bold tracking-wider text-cyan-300">LEAD WAKE PARTICLES</div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="text-red-400">Red: Severe (&gt;10 m/s)</span>
          <span className="text-amber-300">Yellow: Moderate (&gt;4 m/s)</span>
          <span className="text-blue-300">Blue: Safe</span>
        </div>
      </div>

      <Canvas camera={{ position: [12.5, 7.8, 12.5], fov: 44 }}>
        <color attach="background" args={[lightMode ? '#cbd5e1' : '#040812']} />
        <fog attach="fog" args={[lightMode ? '#cbd5e1' : '#040812', 24, 58]} />
        <ambientLight intensity={lightMode ? 1.35 : 1.15} />
        <directionalLight position={[14, 22, 12]} intensity={2.2} color="#ffffff" />
        <directionalLight position={[-10, 8, -10]} intensity={0.85} color="#bae6fd" />
        <CameraController preset={cameraPreset} encounterPoint={telemetry.encounterPoint3D} />
        <WindParticles signedCrosswindKts={signedCrosswindKts} headwindKts={headwindKts} isPlaying={params.isPlaying} />

        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, -4]}>
          <planeGeometry args={[2.8, 36]} />
          <meshStandardMaterial color="#0b1222" />
        </mesh>
        <Line points={[[-1.35, 0.02, -22], [-1.35, 0.02, 14]]} color="#38bdf8" lineWidth={1.5} />
        <Line points={[[1.35, 0.02, -22], [1.35, 0.02, 14]]} color="#38bdf8" lineWidth={1.5} />
        <Line points={[[0, 0.03, -22], [0, 0.03, 14]]} color="#94a3b8" lineWidth={2} dashed dashSize={0.7} gapSize={0.5} />

        <Html position={[0, 0.08, 11.5]} rotation={[-Math.PI / 2, 0, 0]} transform>
          <div className="text-slate-500 font-mono font-black text-2xl tracking-widest select-none">{airportSpec.runway}</div>
        </Html>

        <Grid infiniteGrid fadeDistance={44} sectionColor={lightMode ? '#94a3b8' : '#1e293b'} cellColor={lightMode ? '#cbd5e1' : '#0f172a'} />
        <AnimatedAirspace
          flights={flights}
          params={params}
          telemetry={telemetry}
          recommendedOffset={recommendedOffset}
          onSelectFlight={onSelectFlight}
        />
        <OrbitControls makeDefault maxPolarAngle={Math.PI / 2.05} />
      </Canvas>
    </div>
  );
}
