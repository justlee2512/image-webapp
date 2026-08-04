const input = document.querySelector('#image-input');
const uploadForm = document.querySelector('.upload-form');
const progressBox = document.querySelector('#upload-progress');
const toastStack = document.querySelector('#toast-stack');

function showToast(message, type = 'error') {
  if (!message || !toastStack) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type} is-visible`;
  toast.textContent = message;
  toastStack.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('is-hiding');
    window.setTimeout(() => toast.remove(), 220);
  }, 3200);
}

function showInlineAlerts() {
  document.querySelectorAll('.alert').forEach((alert) => {
    if (!alert.classList.contains('toast')) {
      alert.classList.add('toast');
      alert.classList.add('is-visible');
      window.setTimeout(() => {
        alert.classList.add('is-hiding');
        window.setTimeout(() => alert.remove(), 220);
      }, 3200);
    }
  });
}

showInlineAlerts();
try {
  const savedSummary = sessionStorage.getItem('image-drive-upload-summary');
  if (savedSummary) {
    sessionStorage.removeItem('image-drive-upload-summary');
    const summary = JSON.parse(savedSummary);
    showToast(summary.message, summary.type || 'success');
  }
} catch (error) {
  console.warn('Cannot restore upload summary', error);
}

async function submitAjaxForm(event) {
  const form = event.currentTarget;
  const submitter = event.submitter;
  const actionUrl = submitter?.getAttribute('formaction') || form.getAttribute('action') || form.action;
  const formData = new FormData(form);
  const body = new URLSearchParams(formData);
  try {
    const response = await fetch(actionUrl, {
      method: form.method || 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) throw new Error(result?.message || 'Không thể thực hiện thao tác.');
    showToast(result.message || 'Thao tác thành công.', 'success');
    window.setTimeout(() => window.location.reload(), 300);
  } catch (error) {
    showToast(error.message || 'Không thể thực hiện thao tác.', 'error');
  }
}

document.querySelectorAll('form[data-ajax-form]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAjaxForm(event);
  });
});
const progressBar = document.querySelector('#upload-bar');
const progressStatus = document.querySelector('#upload-status');
const progressPercent = document.querySelector('#upload-percent');
const uploadButton = uploadForm?.querySelector('.upload-button');
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unitIndex)).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function setUploadProgress(value, status) {
  const safeValue = Math.max(0, Math.min(100, Math.round(value)));
  if (progressBar) progressBar.value = safeValue;
  if (progressPercent) progressPercent.textContent = `${safeValue}%`;
  if (progressStatus && status) progressStatus.textContent = status;
}

function uploadOne(file, folderId, index, total, batchTotalBytes) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const data = new FormData();
    data.append('folderId', folderId);
    data.append('image', file, file.name);

    request.open('POST', '/images');
    request.responseType = 'json';
    request.timeout = 10 * 60 * 1000;
    request.setRequestHeader('Accept', 'application/json');
    request.setRequestHeader('X-Upload-Queue', 'sequential');
    request.setRequestHeader('X-Upload-Batch-Count', String(total));
    request.setRequestHeader('X-Upload-Batch-Total-Bytes', String(batchTotalBytes));
    request.setRequestHeader('X-Upload-Batch-Index', String(index + 1));

    request.upload.addEventListener('progress', (event) => {
      const fileRatio = event.lengthComputable ? event.loaded / event.total : 0;
      const batchRatio = (index + (fileRatio * 0.82)) / total;
      setUploadProgress(
        batchRatio * 100,
        `Đang gửi ${index + 1}/${total}: ${file.name} (${formatBytes(event.loaded)}/${formatBytes(event.total || file.size)})`,
      );
    });

    request.upload.addEventListener('load', () => {
      const batchRatio = (index + 0.9) / total;
      setUploadProgress(
        batchRatio * 100,
        `Đã gửi ${index + 1}/${total}: ${file.name}. Máy chủ đang tạo thumbnail và lưu dữ liệu...`,
      );
    });

    request.addEventListener('load', () => {
      const response = request.response || {};
      if (request.responseURL?.includes('/login')) {
        reject(new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'));
        return;
      }
      if (request.status >= 200 && request.status < 300 && response.ok !== false) {
        resolve(response);
        return;
      }
      reject(new Error(response.message || `Upload thất bại (HTTP ${request.status}).`));
    });
    request.addEventListener('error', () => reject(new Error('Mất kết nối khi upload.')));
    request.addEventListener('abort', () => reject(new Error('Upload đã bị hủy.')));
    request.addEventListener('timeout', () => reject(new Error('Máy chủ xử lý quá lâu và request đã hết thời gian chờ.')));
    request.send(data);
  });
}

if (input && uploadForm) input.addEventListener('change', async () => {
  const files = [...input.files];
  if (!files.length) return;

  const maxSizeMb = Number(input.dataset.maxSizeMb || 30);
  const maxFiles = Number(input.dataset.maxFiles || 50);
  const maxTotalSizeMb = Number(input.dataset.maxTotalSizeMb || 1024);
  const maxBytes = maxSizeMb * 1024 * 1024;
  const maxTotalBytes = maxTotalSizeMb * 1024 * 1024;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const folderId = uploadForm.querySelector('[name="folderId"]')?.value || '';

  if (files.length > maxFiles) {
    showToast(`Chỉ được chọn tối đa ${maxFiles} ảnh mỗi lần.`, 'error');
    input.value = '';
    return;
  }
  if (totalBytes > maxTotalBytes) {
    showToast(`Tổng dung lượng ${formatBytes(totalBytes)} vượt giới hạn ${formatBytes(maxTotalBytes)}.`, 'error');
    input.value = '';
    return;
  }

  const unsupported = files.find((file) => !allowedImageTypes.has(file.type));
  if (unsupported) {
    showToast(`${unsupported.name} không thuộc định dạng JPG, PNG, GIF hoặc WebP.`, 'error');
    input.value = '';
    return;
  }

  const oversized = files.find((file) => file.size > maxBytes);
  if (oversized) {
    showToast(`${oversized.name} vượt quá ${maxSizeMb} MB/ảnh.`, 'error');
    input.value = '';
    return;
  }

  input.disabled = true;
  uploadButton?.classList.add('disabled');
  progressBox?.classList.remove('upload-failed');
  if (progressBox) progressBox.hidden = false;
  setUploadProgress(0, `Chuẩn bị upload ${files.length} ảnh (${formatBytes(totalBytes)})...`);

  let successful = 0;
  const failures = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    try {
      await uploadOne(file, folderId, index, files.length, totalBytes);
      successful += 1;
      setUploadProgress(
        ((index + 1) / files.length) * 100,
        `Đã xử lý xong ${index + 1}/${files.length}: ${file.name}`,
      );
    } catch (error) {
      failures.push({ name: file.name, reason: error.message });
      progressBox?.classList.add('upload-failed');
      setUploadProgress(
        ((index + 1) / files.length) * 100,
        `Lỗi ${file.name}: ${error.message}. Tiếp tục ảnh kế tiếp...`,
      );
    }
  }

  const failed = failures.length;
  const failureDetails = failures
    .slice(0, 3)
    .map((item) => `${item.name}: ${item.reason}`)
    .join(' | ');
  const extraFailures = failed > 3 ? ` | và ${failed - 3} ảnh lỗi khác` : '';
  const message = failed === 0
    ? `Hoàn tất ${successful}/${files.length} ảnh.`
    : `Đã tải ${successful}/${files.length} ảnh; ${failed} ảnh lỗi. ${failureDetails}${extraFailures}`;

  setUploadProgress(100, message);
  input.value = '';

  if (successful > 0) {
    try {
      sessionStorage.setItem('image-drive-upload-summary', JSON.stringify({
        message,
        type: failed === 0 ? 'success' : 'error',
      }));
    } catch (error) {
      console.warn('Cannot save upload summary', error);
    }
    window.setTimeout(() => window.location.reload(), 700);
    return;
  }

  input.disabled = false;
  uploadButton?.classList.remove('disabled');
  progressBox?.classList.add('upload-failed');
  showToast(message, 'error');
});

const selectAll = document.querySelector('#select-all');
const checkboxes = [...document.querySelectorAll('.image-checkbox')];
const batchDownload = document.querySelector('#batch-download');
const batchDelete = document.querySelector('#batch-delete');
const batchMove = document.querySelector('#batch-move');
function updateBatchButton() {
  const selected = checkboxes.filter((checkbox) => checkbox.checked).length;
  if (batchDownload) {
    batchDownload.disabled = selected === 0;
    batchDownload.textContent = selected ? `↓ Tải ${selected} ảnh (.zip)` : '↓ Tải ảnh đã chọn (.zip)';
  }
  if (batchDelete) {
    batchDelete.disabled = selected === 0;
    batchDelete.textContent = selected ? `⌫ Xóa ${selected} ảnh` : '⌫ Xóa ảnh đã chọn';
  }
  if (batchMove) batchMove.disabled = selected === 0;
  if (selectAll) selectAll.checked = checkboxes.length > 0 && selected === checkboxes.length;
}
if (selectAll) selectAll.addEventListener('change', () => { checkboxes.forEach((checkbox) => { checkbox.checked = selectAll.checked; }); updateBatchButton(); });
checkboxes.forEach((checkbox) => checkbox.addEventListener('change', updateBatchButton));

if (batchDelete) batchDelete.addEventListener('click', (event) => {
  const selected = checkboxes.filter((checkbox) => checkbox.checked).length;
  if (!window.confirm(`Bạn chắc chắn muốn xóa ${selected} ảnh đã chọn? Hành động này không thể hoàn tác.`)) event.preventDefault();
});

const deleteAll = document.querySelector('.delete-all');
if (deleteAll) deleteAll.addEventListener('click', (event) => {
  if (!window.confirm(`Xóa toàn bộ ${checkboxes.length} ảnh trong thư mục hiện tại? Hành động này không thể hoàn tác.`)) event.preventDefault();
});

const photoCards = [...document.querySelectorAll('.photo-card[draggable="true"]')];
const folderTargets = [...document.querySelectorAll('.folder-drop-target[data-folder-id]')];
photoCards.forEach((card) => {
  card.addEventListener('dragstart', (event) => {
    const selectedIds = checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
    const ids = selectedIds.includes(card.dataset.imageId) ? selectedIds : [card.dataset.imageId];
    event.dataTransfer.setData('application/json', JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
});

folderTargets.forEach((folder) => {
  folder.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; folder.classList.add('drag-over'); });
  folder.addEventListener('dragleave', () => folder.classList.remove('drag-over'));
  folder.addEventListener('drop', async (event) => {
    event.preventDefault();
    folder.classList.remove('drag-over');
    let ids;
    try { ids = JSON.parse(event.dataTransfer.getData('application/json')); } catch { return; }
    if (!ids?.length) return;
    const body = new URLSearchParams();
    ids.forEach((id) => body.append('imageIds', id));
    body.set('targetFolderId', folder.dataset.folderId);
    try {
      const response = await fetch('/images/move', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message);
      window.location.reload();
    } catch (error) { window.alert(error.message || 'Không thể di chuyển ảnh.'); }
  });
});

const previews = [...document.querySelectorAll('.photo-preview')];
const lightbox = document.querySelector('#lightbox');
const lightboxImage = document.querySelector('#lightbox-image');
const lightboxName = document.querySelector('#lightbox-name');
const lightboxCount = document.querySelector('#lightbox-count');
const lightboxDownload = document.querySelector('#lightbox-download');
const lightboxLoader = document.querySelector('#lightbox-loader');
const previousButton = document.querySelector('#lightbox-prev');
const nextButton = document.querySelector('#lightbox-next');
const zoomInButton = document.querySelector('#zoom-in');
const zoomOutButton = document.querySelector('#zoom-out');
const zoomLevelButton = document.querySelector('#zoom-level');
const lightboxStage = document.querySelector('.lightbox-stage');
let activeImageIndex = 0;
let zoomLevel = 1;
let fittedImageWidth = 0;
let fittedImageHeight = 0;
let panState = null;

function setZoom(nextZoom) {
  zoomLevel = Math.min(4, Math.max(0.5, Math.round(nextZoom * 10) / 10));
  if (zoomLevel > 1 && fittedImageWidth && fittedImageHeight) {
    lightboxImage.style.width = `${Math.round(fittedImageWidth * zoomLevel)}px`;
    lightboxImage.style.height = `${Math.round(fittedImageHeight * zoomLevel)}px`;
    lightboxImage.style.maxWidth = 'none';
    lightboxImage.style.maxHeight = 'none';
    lightboxImage.style.transform = 'scale(1)';
  } else {
    lightboxImage.style.width = '';
    lightboxImage.style.height = '';
    lightboxImage.style.maxWidth = '';
    lightboxImage.style.maxHeight = '';
    lightboxImage.style.transform = `scale(${zoomLevel})`;
  }
  zoomLevelButton.textContent = `${Math.round(zoomLevel * 100)}%`;
  lightboxStage.classList.toggle('is-zoomed', zoomLevel > 1);
  if (zoomLevel > 1) {
    lightboxStage.scrollLeft = Math.max(0, (lightboxStage.scrollWidth - lightboxStage.clientWidth) / 2);
    lightboxStage.scrollTop = Math.max(0, (lightboxStage.scrollHeight - lightboxStage.clientHeight) / 2);
  } else {
    lightboxStage.scrollTop = 0;
    lightboxStage.scrollLeft = 0;
  }
}

function showLightboxImage(index) {
  if (!previews.length) return;
  activeImageIndex = (index + previews.length) % previews.length;
  const preview = previews[activeImageIndex];
  const imageId = preview.dataset.imageId;
  const imageName = preview.dataset.imageName;
  fittedImageWidth = 0;
  fittedImageHeight = 0;
  setZoom(1);
  lightbox.classList.add('loading');
  lightboxLoader.hidden = false;
  lightboxImage.classList.remove('loaded');
  lightboxImage.alt = imageName;
  lightboxName.textContent = imageName;
  lightboxCount.textContent = `${activeImageIndex + 1} / ${previews.length}`;
  lightboxDownload.href = `/images/${imageId}/download`;
  lightboxImage.src = `/images/${imageId}`;
  previousButton.hidden = previews.length < 2;
  nextButton.hidden = previews.length < 2;
}

function openLightbox(index) {
  showLightboxImage(index);
  lightbox.classList.add('open');
  lightbox.setAttribute('aria-hidden', 'false');
  document.body.classList.add('lightbox-open');
}

function closeLightbox() {
  stopPanning();
  lightbox.classList.remove('open');
  lightbox.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('lightbox-open');
  window.setTimeout(() => { if (!lightbox.classList.contains('open')) lightboxImage.src = ''; }, 250);
}

previews.forEach((preview, index) => preview.addEventListener('click', (event) => { event.preventDefault(); openLightbox(index); }));
lightboxImage?.addEventListener('load', () => {
  lightbox.classList.remove('loading');
  lightboxLoader.hidden = true;
  lightboxImage.classList.add('loaded');
  lightboxImage.style.transform = 'scale(1)';
  fittedImageWidth = lightboxImage.clientWidth;
  fittedImageHeight = lightboxImage.clientHeight;
});
document.querySelectorAll('[data-lightbox-close]').forEach((element) => element.addEventListener('click', closeLightbox));
previousButton?.addEventListener('click', () => showLightboxImage(activeImageIndex - 1));
nextButton?.addEventListener('click', () => showLightboxImage(activeImageIndex + 1));
zoomInButton?.addEventListener('click', () => setZoom(zoomLevel + 0.25));
zoomOutButton?.addEventListener('click', () => setZoom(zoomLevel - 0.25));
zoomLevelButton?.addEventListener('click', () => setZoom(1));
lightboxStage?.addEventListener('dblclick', () => setZoom(zoomLevel === 1 ? 2 : 1));
lightboxStage?.addEventListener('wheel', (event) => {
  if (!lightbox?.classList.contains('open')) return;
  event.preventDefault();
  setZoom(zoomLevel + (event.deltaY < 0 ? 0.25 : -0.25));
}, { passive: false });

lightboxStage?.addEventListener('pointerdown', (event) => {
  if (zoomLevel <= 1 || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  panState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: lightboxStage.scrollLeft,
    scrollTop: lightboxStage.scrollTop
  };
  lightboxStage.setPointerCapture(event.pointerId);
  lightboxStage.classList.add('is-panning');
});

lightboxStage?.addEventListener('pointermove', (event) => {
  if (!panState || panState.pointerId !== event.pointerId) return;
  event.preventDefault();
  lightboxStage.scrollLeft = panState.scrollLeft - (event.clientX - panState.startX);
  lightboxStage.scrollTop = panState.scrollTop - (event.clientY - panState.startY);
});

function stopPanning(event) {
  if (!panState || (event && panState.pointerId !== event.pointerId)) return;
  if (event && lightboxStage.hasPointerCapture(event.pointerId)) lightboxStage.releasePointerCapture(event.pointerId);
  panState = null;
  lightboxStage.classList.remove('is-panning');
}

lightboxStage?.addEventListener('pointerup', stopPanning);
lightboxStage?.addEventListener('pointercancel', stopPanning);
lightboxStage?.addEventListener('lostpointercapture', () => stopPanning());
document.addEventListener('keydown', (event) => {
  if (!lightbox?.classList.contains('open')) return;
  if (event.key === 'Escape') closeLightbox();
  if (event.key === 'ArrowLeft') showLightboxImage(activeImageIndex - 1);
  if (event.key === 'ArrowRight') showLightboxImage(activeImageIndex + 1);
});
