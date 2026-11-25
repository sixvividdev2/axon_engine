import React, { useEffect, useRef, useState } from 'react';
import { TutorialEngine, TutorialSnapshot } from './TutorialEngine';
import { TutorialHud } from './TutorialHud';

interface TutorialViewProps {
  returnLabel?: string;
  onExit: () => void;
}

export const TutorialView: React.FC<TutorialViewProps> = ({
  returnLabel = 'Return to Hideout',
  onExit,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<TutorialEngine | null>(null);
  const [snapshot, setSnapshot] = useState<TutorialSnapshot | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const engine = new TutorialEngine(el);
    engineRef.current = engine;
    const unsub = engine.subscribe((next) => {
      setSnapshot(next);
    });

    return () => {
      unsub();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const engine = engineRef.current;

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-neutral-950">
      <div ref={containerRef} className="fixed inset-0 h-full w-full" />

      {snapshot && (
        <TutorialHud
          snapshot={snapshot}
          returnLabel={returnLabel}
          onRequestLock={() => engine?.requestLock()}
          onSkipStep={() => engine?.skipCurrentStep()}
          onJumpStep={(idx) => engine?.jumpToStep(idx)}
          onRestart={() => engine?.restartCourse()}
          onVolumeChange={(v) => engine?.setMasterVolume(v)}
          onExit={onExit}
        />
      )}
    </main>
  );
};
