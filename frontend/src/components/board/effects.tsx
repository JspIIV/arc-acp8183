import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";

// ── Dispute Dome — arc blue pulsing hemisphere ────────────────────────────────
export function DisputeDome({ position, nodes = 5 }: { position: [number,number,number]; nodes?: number }) {
  const dome = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Group>(null);
  useFrame((s) => {
    const t = s.clock.elapsedTime;
    if (dome.current) {
      (dome.current.material as THREE.MeshStandardMaterial).opacity = 0.16 + Math.sin(t*2.2)*0.08;
      dome.current.scale.setScalar(1 + Math.sin(t*2.2)*0.03);
    }
    if (ring.current) ring.current.rotation.y = t*0.6;
  });
  return (
    <group position={position}>
      <mesh ref={dome}>
        <sphereGeometry args={[3, 24, 16, 0, Math.PI*2, 0, Math.PI/2]} />
        <meshStandardMaterial color="#acc6e9" emissive="#acc6e9" emissiveIntensity={0.9}
          transparent opacity={0.2} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <group ref={ring} position={[0, 2.4, 0]}>
        {Array.from({ length: nodes }).map((_, i) => {
          const a = (i/nodes)*Math.PI*2;
          return (
            <mesh key={i} position={[Math.cos(a)*2.5, 0, Math.sin(a)*2.5]}>
              <boxGeometry args={[0.18, 0.18, 0.18]} />
              <meshStandardMaterial color="#cbdbf2" emissive="#cbdbf2" emissiveIntensity={2} />
            </mesh>
          );
        })}
      </group>
    </group>
  );
}

// ── Containment Grid — red cage for suspended agents ──────────────────────────
export function ContainmentGrid({ position }: { position: [number,number,number] }) {
  const beacons = useRef<THREE.Group>(null);
  const R = 3;
  const box = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(R*2, 2.8, R*2)), []);
  useFrame((s) => {
    beacons.current?.children.forEach((c, i) => {
      const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 1 + Math.abs(Math.sin(s.clock.elapsedTime*3+i))*3;
    });
  });
  const corners: [number,number][] = [[-R,-R],[R,-R],[R,R],[-R,R]];
  return (
    <group position={position}>
      <lineSegments position={[0,1.4,0]} geometry={box}>
        <lineBasicMaterial color="#e86d7a" transparent opacity={0.8} />
      </lineSegments>
      <mesh position={[0,1.4,0]} rotation={[Math.PI/2,0,0]}>
        <torusGeometry args={[R*1.05, 0.05, 8, 48]} />
        <meshStandardMaterial color="#e86d7a" emissive="#e86d7a" emissiveIntensity={1.6} />
      </mesh>
      <group ref={beacons}>
        {corners.map(([x,z],i) => (
          <mesh key={i} position={[x,2.9,z]}>
            <sphereGeometry args={[0.16,10,10]} />
            <meshStandardMaterial color="#e86d7a" emissive="#e86d7a" emissiveIntensity={2} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

// ── Contract Arc — photon-carrying line between two agents ────────────────────
const PHOTONS = 4;
export type ArcPattern = "solid" | "dashed" | "dotted";

export function ContractArc({ a, b, color, opacity, selected, pending, busy, pattern = "solid", onSelect }: {
  a: THREE.Vector3; b: THREE.Vector3; color: string; opacity: number;
  selected: boolean; pending: boolean; busy: boolean; pattern?: ArcPattern; onSelect: () => void;
}) {
  const photons = useRef<THREE.Group>(null);
  const pt = useRef(new THREE.Vector3());
  const phase = useRef(0);
  const curve = useMemo(() => {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += a.distanceTo(b)*0.18 + 2.5;
    return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
  }, [a, b]);
  useFrame((_, dt) => {
    if (!photons.current) return;
    phase.current += dt*(busy ? 0.9 : 0.25);
    const n = photons.current.children.length;
    photons.current.children.forEach((c,i) => c.position.copy(curve.getPoint((phase.current+i/n)%1, pt.current)));
  });
  const points = useMemo(() => curve.getPoints(64), [curve]);
  const shown = pending ? opacity*0.45 : opacity;
  return (
    <group onClick={(e) => { e.stopPropagation(); onSelect(); }}>
      {pattern === "solid" ? (
        <mesh>
          <tubeGeometry args={[curve, 48, selected ? 0.09 : 0.05, 6, false]} />
          <meshBasicMaterial color={color} transparent opacity={shown} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      ) : (
        <Line points={points} color={color} lineWidth={selected ? 3.5 : 2.2} transparent opacity={shown}
          depthWrite={false} dashed dashSize={pattern==="dashed"?0.9:0.15} gapSize={pattern==="dashed"?0.5:0.35} />
      )}
      <mesh>
        <tubeGeometry args={[curve, 24, 0.5, 6, false]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {!pending && opacity > 0.3 && (
        <group ref={photons}>
          {Array.from({ length: PHOTONS }).map((_, i) => (
            <mesh key={i}>
              <sphereGeometry args={[busy ? 0.12 : 0.07, 8, 8]} />
              <meshBasicMaterial color={busy?"#ffffff":color} transparent opacity={opacity}
                blending={THREE.AdditiveBlending} depthWrite={false} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}

// ── Arc Escrow Hub — central rotating Arc-blue icosahedron ───────────────────
export function EscrowHub({ escrow, reserves, showLabel }: { escrow: number; reserves: number; showLabel: boolean }) {
  const core = useRef<THREE.Mesh>(null);
  const rings = useRef<THREE.Group>(null);
  useFrame((s) => {
    const t = s.clock.elapsedTime;
    if (core.current) { core.current.rotation.y = t*0.4; core.current.rotation.x = t*0.25; }
    if (rings.current) rings.current.rotation.y = -t*0.2;
  });
  return (
    <group position={[0, 1.4, 0]}>
      {/* Platform */}
      <mesh receiveShadow castShadow>
        <cylinderGeometry args={[4.2, 3.4, 1, 8]} />
        <meshStandardMaterial color="#0d1b2f" roughness={0.4} metalness={0.8} />
      </mesh>
      {/* Glowing ring on platform — Arc accent blue */}
      <mesh position={[0, 0.52, 0]} rotation={[-Math.PI/2, 0, 0]}>
        <ringGeometry args={[3.2, 3.5, 8]} />
        <meshStandardMaterial color="#acc6e9" emissive="#acc6e9" emissiveIntensity={1.8} side={THREE.DoubleSide} />
      </mesh>
      {/* Floating icosahedron — Arc blue core */}
      <mesh ref={core} position={[0, 3, 0]}>
        <icosahedronGeometry args={[1.1, 0]} />
        <meshStandardMaterial color="#acc6e9" emissive="#5b8fbd" emissiveIntensity={1.6} metalness={0.8} roughness={0.25} flatShading />
      </mesh>
      {/* Orbital rings */}
      <group ref={rings} position={[0, 3, 0]}>
        {[1.9, 2.5].map((r, i) => (
          <mesh key={r} rotation={[Math.PI/2 + i*0.5, i*0.7, 0]}>
            <torusGeometry args={[r, 0.035, 8, 64]} />
            <meshStandardMaterial color="#cbdbf2" emissive="#acc6e9" emissiveIntensity={2.2} />
          </mesh>
        ))}
      </group>
      <pointLight position={[0,4,0]} color="#acc6e9" intensity={22} distance={26} decay={2} />
      {showLabel && (
        <Html center position={[0, 6.2, 0]} pointerEvents="none" zIndexRange={[0,10]}>
          <div style={{
            fontFamily: "ui-monospace, SFMono-Regular, monospace", whiteSpace: "nowrap", textAlign: "center",
            background: "rgba(13,27,47,0.9)", border: "1px solid rgba(172,198,233,0.4)",
            borderRadius: 6, padding: "4px 10px",
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "#acc6e9" }}>ARC ESCROW</div>
            {!(typeof window !== "undefined" && window.innerWidth < 640) && (
              <div style={{ fontSize: 9, color: "#94a3b8", letterSpacing: 0.8, marginTop: 1 }}>
                {escrow.toFixed(2)} USDC LOCKED · {reserves.toFixed(2)} RESERVES
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

// ── Particle Field — drifting Arc-blue dust ────────────────────────────────────
export function ParticleField({ count = 900 }: { count?: number }) {
  const ref = useRef<THREE.Points>(null);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(count*3);
    for (let i = 0; i < count; i++) {
      const r = 10 + Math.random()*70;
      const a = Math.random()*Math.PI*2;
      p[i*3] = Math.cos(a)*r; p[i*3+1] = -2+Math.random()*22; p[i*3+2] = Math.sin(a)*r;
    }
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    return g;
  }, [count]);
  useFrame((s) => { if (ref.current) ref.current.rotation.y = s.clock.elapsedTime*0.01; });
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial color="#acc6e9" size={0.08} transparent opacity={0.45} depthWrite={false} />
    </points>
  );
}
