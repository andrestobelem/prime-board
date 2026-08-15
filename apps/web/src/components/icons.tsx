// Íconos monocromo de la UI (AT-172): SVG inline, sin dependencias externas.
//
// Los trazos derivan de Lucide (https://lucide.dev), vendorizados en vez de
// instalar `lucide-react`: el set que necesita la app es chico y así viaja con
// el repo. Los tres íconos marcados como "custom" están dibujados a mano sobre
// el mismo grid (24×24, stroke 2) para que convivan sin costura con los demás.
//
// ---------------------------------------------------------------------------
// ISC License
//
// Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
// of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
// Contributors 2022.
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
// ---------------------------------------------------------------------------

/**
 * Trazos de cada ícono, en el grid nativo de 24×24.
 *
 * Todo hereda el color con `currentColor`, así que un ícono se pinta cambiando
 * el `color` del contenedor (nunca con colores hardcodeados acá adentro).
 */
const PATHS = {
  // -- navegación y chrome -------------------------------------------------
  /** Marca del workspace en el sidebar (lucide: layers). */
  workspace: (
    <>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
      <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
      <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
    </>
  ),
  /** Lista de issues (lucide: list). */
  issues: (
    <>
      <path d="M3 5h.01" />
      <path d="M3 12h.01" />
      <path d="M3 19h.01" />
      <path d="M8 5h13" />
      <path d="M8 12h13" />
      <path d="M8 19h13" />
    </>
  ),
  /** Team, identificado por su key (lucide: hash). */
  "team-key": (
    <>
      <line x1="4" x2="20" y1="9" y2="9" />
      <line x1="4" x2="20" y1="15" y2="15" />
      <line x1="10" x2="8" y1="3" y2="21" />
      <line x1="16" x2="14" y1="3" y2="21" />
    </>
  ),
  /** Proyecto (lucide: box). */
  project: (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </>
  ),
  /** Milestone de un proyecto (lucide: diamond). */
  milestone: (
    <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z" />
  ),
  /** Members del workspace (lucide: users). */
  members: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <circle cx="9" cy="7" r="4" />
    </>
  ),
  /** Settings (lucide: settings). */
  settings: (
    <>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  /** Chevron a la derecha: breadcrumbs y secciones colapsadas (lucide). */
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  /** Chevron hacia abajo: caret del switcher y secciones abiertas (lucide). */
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  /** Subir un elemento en una lista ordenable (lucide: arrow-up). */
  "arrow-up": (
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>
  ),
  /** Bajar un elemento en una lista ordenable (lucide: arrow-down). */
  "arrow-down": (
    <>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </>
  ),
  /** Confirmación efímera, tipo "copiado" (lucide: check). */
  check: <path d="M20 6 9 17l-5-5" />,

  // -- prioridad -----------------------------------------------------------
  // Barras crecientes al estilo Linear: high 3, medium 2, low 1.
  /** Prioridad urgente: cuadrado redondeado con "!" (custom). */
  "priority-urgent": (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5h.01" />
    </>
  ),
  /** Prioridad alta (lucide: signal-high). */
  "priority-high": (
    <>
      <path d="M2 20h.01" />
      <path d="M7 20v-4" />
      <path d="M12 20v-8" />
      <path d="M17 20V8" />
    </>
  ),
  /** Prioridad media (lucide: signal-medium). */
  "priority-medium": (
    <>
      <path d="M2 20h.01" />
      <path d="M7 20v-4" />
      <path d="M12 20v-8" />
    </>
  ),
  /** Prioridad baja (lucide: signal-low). */
  "priority-low": (
    <>
      <path d="M2 20h.01" />
      <path d="M7 20v-4" />
    </>
  ),
  /** Sin prioridad: tres guiones apilados (custom). */
  "priority-none": (
    <>
      <path d="M6.5 8h11" />
      <path d="M6.5 12h11" />
      <path d="M6.5 16h11" />
    </>
  ),

  // -- estados del workflow ------------------------------------------------
  /** Triage: pendiente de clasificar (lucide: circle-dot). */
  "state-triage": (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  /** Backlog (lucide: circle-dashed). */
  "state-backlog": (
    <>
      <path d="M10.1 2.182a10 10 0 0 1 3.8 0" />
      <path d="M13.9 21.818a10 10 0 0 1-3.8 0" />
      <path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" />
      <path d="M2.182 13.9a10 10 0 0 1 0-3.8" />
      <path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" />
      <path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
      <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" />
      <path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" />
    </>
  ),
  /** Todo / unstarted (lucide: circle). */
  "state-todo": <circle cx="12" cy="12" r="10" />,
  /** En progreso: círculo con sector relleno tipo torta (custom). */
  "state-in-progress": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 12V6.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" stroke="none" />
    </>
  ),
  /** Completado (lucide: circle-check). */
  "state-done": (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  /** Cancelado (lucide: circle-x). */
  "state-canceled": (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </>
  ),
};

/** Nombre de ícono disponible; el compilador rechaza cualquier otro. */
export type IconName = keyof typeof PATHS;

export interface IconProps {
  name: IconName;
  /** Lado del cuadrado en px; el trazo escala solo desde el grid de 24. */
  size?: number;
  className?: string;
  /**
   * Texto accesible. Si se pasa, el ícono se anuncia como imagen con ese
   * nombre; si no, queda oculto para lectores de pantalla (decorativo).
   */
  title?: string;
}

export function Icon({ name, size = 16, className, title }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}
