# ADR-0028: Local Sentinel mirror + STAC

**Decision.** Sentinel-1 GRD and Sentinel-2 L2A for the Punjab and Sindh AOIs pulled via `eodag` from the Copernicus Data Space, converted to COGs, stored in `argus-sentinel`, indexed in `pgstac` on PostgreSQL. TiTiler (Python, Windows) serves dynamic raster tiles; Martin (Rust, Windows build) serves parcel vector tiles from PostGIS.

**Why.** The single largest performance change available: pipelines stop pulling scenes over Pakistani bandwidth on every run, and the dashboard map stops shipping megabyte GeoJSON.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
