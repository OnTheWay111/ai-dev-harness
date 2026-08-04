import type { ReactNode } from "react";

import type { StatusTone } from "../contracts";
import { steps } from "../view-data";

export function StatusPill({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}
export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress-track" aria-label={`进度 ${value}%`}>
      <div className="progress-fill" style={{ width: `${value}%` }} />
    </div>
  );
}

export function Stepper({ current }: { current: number }) {
  return (
    <ol className="stepper" aria-label="七阶段开发流程">
      {steps.map((step, index) => (
        <li
          key={step}
          className={`${index < current ? "done" : ""} ${
            index === current ? "current" : ""
          }`}
        >
          <span>{index < current ? "✓" : index + 1}</span>
          <strong>{step}</strong>
          {index < steps.length - 1 && <i />}
        </li>
      ))}
    </ol>
  );
}
