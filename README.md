# TelemetryFlightViewer
A local webapp for replaying csv flight logs with map visualization and telemetry graphs


<img width="2953" height="1744" alt="viewer" src="https://github.com/user-attachments/assets/92951f6a-61aa-492a-98f6-b0df52154c90" />
<img width="1801" height="1062" alt="Screenshot 2026-03-09 233652" src="https://github.com/user-attachments/assets/bb0a2d63-ea8c-48e9-8969-503cc53b7617" />

A  offline HTML + JavaScript viewer for INAV / Betaflight / Ardupilot /EdgeTX GPS logs.
Tested on csv created by lua telemetry from inav.

Features:
- animated GPS flight replay
- Altitude-colored flight path
- Stats panel (max/avg speed, distance, altitude)
- Offline Leaflet + PapaParse. Still needs internet access from non-cached maps

## How to use

1. Download the repo
2. Open `TelemetryFlightViewer.html` directly in your browser
3. Click “Load CSV”
4. Select your flight log ( CSV format) See examplelog.csv
5. Explanation on how to set up and log telemetry data on your TX can be found here 
   
     https://oscarliang.com/log-telemetry/


## Supports

- GPS field: `"GPS"` formatted as `"lat lon"` - no need to split the cell
- Altitude: `Alt(m)`
- Speed: `GSpd(kmh)`
- Heading: `Hdg(°)`
- Flight mode: `FM`

## No dependencies
Everything is bundled locally:
- Leaflet.js/CSS
- PapaParse
- replay.js

## License
MIT

## Third Party Code and Licenses

This project includes source files from other projects
licensed under the BSD 2-Clause License and the MIT License.

These files are included unchanged.
 
