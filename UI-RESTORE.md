# Image Webapp – Old UI + Optimized Backend

This package restores the visual layout and interactions from the repository state immediately before the security/performance overhaul, while keeping the optimized backend.

## Restored UI

- Green/cream visual theme and original typography feel
- Original top navigation, banner, folder cards and image gallery layout
- Original login, registration and admin-account screens
- Old-style image lightbox with previous/next, zoom and download controls
- Batch selection, move, delete and ZIP download controls
- Drag images onto owned folders

## Retained improvements

- CSRF protection on all state-changing forms and AJAX requests
- Secure session/cookie handling and admin bootstrap using `is_admin`
- Upload signature/metadata validation and image pixel limits
- Login/register rate limiting
- Optimized thumbnail caching, ETag and database access
- Health endpoints, request limits and graceful shutdown
- Non-root/read-only Docker hardening

## Deployment notes

- Keep the existing production Secret values, including `ADMIN_PASSWORD`.
- If the optimized database migration was already applied, no additional migration is required for this UI-only release.
- Build and push a new application image, then update the image tag in the GitOps repository.
