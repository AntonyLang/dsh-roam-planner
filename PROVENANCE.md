# Provenance

This package is an independent MIT implementation. It shares no source code with
TREK or roam-planner.

## Behaviour we deliberately studied

Read from the roam-planner repository (`E:\Antony\Documents\SAD\roam-planner`) to
understand the product, never to copy:

- the draft → candidate → adopt flow: the model edits a draft, a candidate is
  produced for the user, and only an explicit adopt commits the trip;
- the idea that a tool result carries a trip id back to the conversation so a
  later turn resumes the same trip;
- the field vocabulary of a trip (day, stop, leg, revision, status).

## What was not taken

- no source file, type declaration, schema, prompt or documentation text;
- no implementation of the GCJ02 transform: our `client/src/geo.js` is written
  from the public published formulas of the GCJ-02 obfuscation algorithm.

## Third-party runtime

- MapLibre GL JS (BSD-3-Clause) is bundled as-is.
- Basemap tiles and geocoding are the user's own provider and remain subject to
  that provider's terms; attribution is rendered on the map.
