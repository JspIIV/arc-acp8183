import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, PerspectiveCamera, Stars } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import type { World } from "../../lib/engine";
import Island from "./Island";
import { EscrowHub, ParticleField, ContractArc } from "./effects";
import { KIND_COLOR, buildLayouts, islandTopY, type VisualStatus } from "../../lib/world";

export interface BoardProps {
  world: World;
  statusOf: (id: string) => VisualStatus;
  busyContracts: Set<number>;
  escrow: number;
  hoveredId: string | null;
  selectedId: string | null;
  focusId: string | null;
  selectedAgreement: number | null;
  showLabels: boolean;
  interactive?: boolean;
  emphasizeArcs?: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  onSelectAgreement: (id: number) => void;
}

function CameraRig({ camPos, target, flyKey }: { camPos:[number,number,number]; target:[number,number,number]; flyKey:string }) {
  const controls = useThree(s => s.controls) as unknown as {
    target: THREE.Vector3; update: () => void;
    addEventListener:(t:string,f:()=>void)=>void; removeEventListener:(t:string,f:()=>void)=>void;
  } | null;
  const camera = useThree(s => s.camera);
  const wantPos = useRef(new THREE.Vector3(...camPos));
  const wantTgt = useRef(new THREE.Vector3(...target));
  const flying  = useRef(true);
  const grabbed = useRef(false);
  useEffect(() => { wantPos.current.set(...camPos); wantTgt.current.set(...target); flying.current=true; }, [flyKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!controls) return;
    const start = () => { grabbed.current=true; flying.current=false; };
    const end   = () => { grabbed.current=false; };
    controls.addEventListener("start",start); controls.addEventListener("end",end);
    return () => { controls.removeEventListener("start",start); controls.removeEventListener("end",end); };
  }, [controls]);
  useFrame((_,dt) => {
    if (!controls||!flying.current||grabbed.current) return;
    const k=1-Math.exp(-dt*4);
    camera.position.lerp(wantPos.current,k); controls.target.lerp(wantTgt.current,k); controls.update();
    if (camera.position.distanceTo(wantPos.current)<0.4&&controls.target.distanceTo(wantTgt.current)<0.4) flying.current=false;
  });
  return null;
}

function Cursor({ on }: { on: boolean }) {
  useEffect(() => { document.body.style.cursor=on?"pointer":"auto"; return()=>{ document.body.style.cursor="auto"; }; }, [on]);
  return null;
}

const OVERVIEW: [number,number,number] =
  typeof window!=="undefined"&&window.innerWidth<640 ? [70,66,70] : [46,44,46];

export default function Board(p: BoardProps) {
  const layouts = useMemo(() => buildLayouts(p.world.nodes), [p.world.nodes]);
  const byId    = useMemo(() => new Map(layouts.map(l=>[l.id,l])), [layouts]);
  const tops    = useMemo(() => new Map(layouts.map(l=>[l.id, new THREE.Vector3(l.x, islandTopY(l.floatY)+2.6, l.z)])), [layouts]);

  const { camPos, target } = useMemo(() => {
    const l = p.focusId ? byId.get(p.focusId) : undefined;
    if (!l) return { camPos: OVERVIEW, target:[0,0,0] as [number,number,number] };
    const y = islandTopY(l.floatY);
    return { camPos:[l.x+15,y+13,l.z+15] as [number,number,number], target:[l.x,y,l.z] as [number,number,number] };
  }, [p.focusId, byId]);

  const initialPos = useMemo<[number,number,number]>(() => OVERVIEW, []);
  const initialTgt = useMemo<[number,number,number]>(() => [0,0,0], []);
  const focus = p.hoveredId ?? p.selectedId;
  const live  = p.world.agreements.filter(c => c.status==="proposed"||c.status==="active");
  const agCount = (id: string) => live.filter(c => c.status==="active"&&(c.partyA===id||c.partyB===id)).length;

  useEffect(() => { const t=setTimeout(()=>window.dispatchEvent(new Event("resize")),50); return()=>clearTimeout(t); }, []);

  return (
    <div className="absolute inset-0">
      <Cursor on={p.hoveredId!==null} />
      <Canvas shadows dpr={[1,2]} gl={{ antialias:true }} onPointerMissed={() => p.onSelect(null)}>
        <color attach="background" args={["#060f1a"]} />
        <fogExp2 attach="fog" args={["#060f1a",0.0016]} />
        <PerspectiveCamera makeDefault position={initialPos} fov={45} />
        <OrbitControls makeDefault enabled={p.interactive!==false} enableDamping dampingFactor={0.06}
          zoomSpeed={0.7} minDistance={10} maxDistance={130}
          minPolarAngle={0.12} maxPolarAngle={Math.PI/2.2} target={initialTgt} />
        <CameraRig camPos={camPos} target={target} flyKey={p.focusId??"overview"} />
        <ambientLight intensity={0.5} />
        <hemisphereLight args={["#acc6e9","#060f1a",0.4]} />
        <directionalLight position={[0,50,20]} intensity={0.6} />
        <directionalLight position={[30,40,20]} intensity={1.0} castShadow
          shadow-mapSize-width={2048} shadow-mapSize-height={2048}
          shadow-camera-far={160} shadow-camera-left={-70} shadow-camera-right={70}
          shadow-camera-top={70} shadow-camera-bottom={-70} />
        <pointLight position={[-40,18,-32]} intensity={28} distance={90} color="#acc6e9" />
        <pointLight position={[40,16,32]}   intensity={28} distance={90} color="#8dd89f" />
        <Suspense fallback={null}>
          <Stars radius={150} depth={70} count={2400} factor={3} saturation={0} fade speed={0.5} />
          <ParticleField />
          <Grid position={[0,-1.85,0]} args={[10,10]} infiniteGrid cellSize={2} cellThickness={0.6}
            cellColor="#0d1b2f" sectionSize={10} sectionThickness={1} sectionColor="#1a3a5a"
            fadeDistance={150} fadeStrength={2.5} />
          <EscrowHub escrow={p.escrow} reserves={p.world.reserves} showLabel={p.showLabels} />
          {p.world.nodes.map(a => {
            const l = byId.get(a.id);
            if (!l) return null;
            return (
              <Island key={a.id} agent={a} layout={l} status={p.statusOf(a.id)}
                agreementCount={agCount(a.id)}
                active={a.id===p.hoveredId||a.id===p.selectedId}
                isYours={a.owner==="you"} showLabel={p.showLabels}
                onHover={p.onHover} onSelect={p.onSelect} />
            );
          })}
          {live.map(c => {
            const a = tops.get(c.partyA);
            const b = tops.get(c.partyB);
            if (!a||!b) return null;
            const opacity = !focus?0.55:focus===c.partyA||focus===c.partyB?1:0.15;
            return (
              <ContractArc key={c.id} a={a} b={b} color={KIND_COLOR[c.kind]}
                opacity={c.id===p.selectedAgreement||p.emphasizeArcs?1:opacity}
                selected={c.id===p.selectedAgreement||!!p.emphasizeArcs}
                pending={c.status==="proposed"} busy={p.busyContracts.has(c.id)||!!p.emphasizeArcs}
                pattern={c.kind==="SERVICE"?"solid":c.kind==="DATA_SHARING"?"dashed":"dotted"}
                onSelect={() => p.onSelectAgreement(c.id)} />
            );
          })}
          <mesh rotation={[-Math.PI/2,0,0]} position={[0,-1.8,0]} receiveShadow>
            <planeGeometry args={[220,220]} />
            <shadowMaterial transparent opacity={0.3} />
          </mesh>
          <EffectComposer>
            <Bloom luminanceThreshold={0.25} intensity={1.1} luminanceSmoothing={0.9} mipmapBlur />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
}
