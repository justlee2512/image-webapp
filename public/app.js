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

function uploadOne(file, folderId, index, total) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const data = new FormData();
    data.append('folderId', folderId);
    data.append('image', file, file.name);
    request.open('POST', '/images');
    request.setRequestHeader('X-Upload-Queue', 'sequential');
    request.responseType = 'json';
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const fileProgress = event.loaded / event.total;
      const totalProgress = Math.round(((index + fileProgress) / total) * 100);
      progressBar.value = totalProgress;
      progressPercent.textContent = `${totalProgress}%`;
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300 && request.response?.ok) resolve();
      else reject(new Error(request.response?.message || `Không thể tải ${file.name}.`));
    });
    request.addEventListener('error', () => reject(new Error(`Mất kết nối khi tải ${file.name}.`)));
    request.send(data);
  });
}

if (input && uploadForm) input.addEventListener('change', async () => {
  const files = [...input.files];
  if (!files.length) return;
  const maxSizeMb = Number(input.dataset.maxSizeMb || 30);
  const oversized = files.find((file) => file.size > maxSizeMb * 1024 * 1024);
  if (oversized) {
    window.alert(`${oversized.name} lớn hơn giới hạn ${maxSizeMb} MB.`);
    input.value = '';
    return;
  }
  const folderId = uploadForm.querySelector('[name="folderId"]').value;
  const uploadButton = uploadForm.querySelector('.upload-button');
  input.disabled = true;
  uploadButton.classList.add('disabled');
  progressBox.hidden = false;
  let completed = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      progressStatus.textContent = `Đang tải ${index + 1}/${files.length}: ${files[index].name}`;
      await uploadOne(files[index], folderId, index, files.length);
      completed += 1;
      const percent = Math.round((completed / files.length) * 100);
      progressBar.value = percent;
      progressPercent.textContent = `${percent}%`;
    }
    progressStatus.textContent = `Hoàn tất ${completed}/${files.length} ảnh. Đang làm mới…`;
    window.location.reload();
  } catch (error) {
    progressStatus.textContent = `${error.message} Đã hoàn thành ${completed}/${files.length} ảnh.`;
    progressBox.classList.add('upload-failed');
    input.disabled = false;
    uploadButton.classList.remove('disabled');
    input.value = '';
  }
});

const selectAll = document.querySelector('#select-all');
const checkboxes = [...document.querySelectorAll('.image-checkbox')];
const batchDownload = document.querySelector('#batch-download');
const batchDelete = document.querySelector('#batch-delete');
const batchMove = document.querySelector('#batch-move');
const downloadProgressBox = document.querySelector('#download-progress');
const downloadBar = document.querySelector('#download-bar');
const downloadStatus = document.querySelector('#download-status');
const downloadPercent = document.querySelector('#download-percent');
const downloadDetail = document.querySelector('#download-detail');
let isBatchDownloading = false;
function updateBatchButton() {
  const selected = checkboxes.filter((checkbox) => checkbox.checked).length;
  if (batchDownload) {
    batchDownload.disabled = isBatchDownloading || selected === 0;
    batchDownload.textContent = isBatchDownloading
      ? `Đang tải ${selected} ảnh…`
      : (selected ? `↓ Tải ${selected} ảnh` : '↓ Tải ảnh đã chọn');
  }
  if (batchDelete) {
    batchDelete.disabled = isBatchDownloading || selected === 0;
    batchDelete.textContent = selected ? `⌫ Xóa ${selected} ảnh` : '⌫ Xóa ảnh đã chọn';
  }
  if (batchMove) batchMove.disabled = isBatchDownloading || selected === 0;
  if (selectAll) selectAll.checked = checkboxes.length > 0 && selected === checkboxes.length;
}
if (selectAll) selectAll.addEventListener('change', () => { checkboxes.forEach((checkbox) => { checkbox.checked = selectAll.checked; }); updateBatchButton(); });
checkboxes.forEach((checkbox) => checkbox.addEventListener('change', updateBatchButton));

async function getExistingFileNames(directoryHandle) {
  const names = new Set();
  if (!directoryHandle?.keys) return names;
  for await (const name of directoryHandle.keys()) names.add(String(name).toLowerCase());
  return names;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  return `${value >= 100 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function safeDownloadName(name) {
  const baseName = String(name || 'image').split(/[\\/]/).pop();
  return baseName
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 220) || 'image';
}

function uniqueDownloadName(name, reservedNames) {
  const safeName = safeDownloadName(name);
  const dotIndex = safeName.lastIndexOf('.');
  const hasExtension = dotIndex > 0 && dotIndex < safeName.length - 1;
  const stem = hasExtension ? safeName.slice(0, dotIndex) : safeName;
  const extension = hasExtension ? safeName.slice(dotIndex) : '';
  let candidate = safeName;
  let counter = 2;

  while (reservedNames.has(candidate.toLowerCase())) {
    candidate = `${stem} (${counter})${extension}`;
    counter += 1;
  }

  reservedNames.add(candidate.toLowerCase());
  return candidate;
}

async function saveResponseToDirectory(response, directoryHandle, fileName, onProgress) {
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  let loaded = 0;

  try {
    if (!response.body?.getReader) {
      const blob = await response.blob();
      await writable.write(blob);
      loaded = blob.size;
      onProgress(loaded);
    } else {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        loaded += value.byteLength;
        onProgress(loaded);
      }
    }

    await writable.close();
    return loaded;
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function responseToBlob(response, onProgress) {
  if (!response.body?.getReader) {
    const blob = await response.blob();
    onProgress(blob.size);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded);
  }

  return new Blob(chunks, {
    type: response.headers.get('Content-Type') || 'application/octet-stream'
  });
}

function triggerBrowserDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function setDownloadProgress(percent, status, detail) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  downloadBar.value = safePercent;
  downloadPercent.textContent = `${safePercent}%`;
  downloadStatus.textContent = status;
  downloadDetail.textContent = detail;
}

async function downloadSelectedImages() {
  const selected = checkboxes
    .filter((checkbox) => checkbox.checked)
    .map((checkbox, index) => ({
      id: checkbox.value,
      name: checkbox.dataset.imageName || `image-${index + 1}`,
      size: Number(checkbox.dataset.sizeBytes || 0)
    }));

  if (!selected.length || isBatchDownloading) return;

  let directoryHandle = null;
  if ('showDirectoryPicker' in window) {
    try {
      directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.warn('Không thể mở thư mục đích, chuyển sang cơ chế tải của trình duyệt.', error);
    }
  }

  isBatchDownloading = true;
  if (selectAll) selectAll.disabled = true;
  checkboxes.forEach((checkbox) => { checkbox.disabled = true; });
  updateBatchButton();

  downloadProgressBox.hidden = false;
  downloadProgressBox.classList.remove('upload-failed', 'download-complete');

  const totalBytes = selected.reduce((sum, item) => sum + item.size, 0);
  const reservedNames = directoryHandle
    ? await getExistingFileNames(directoryHandle)
    : new Set();

  let completed = 0;
  let completedBytes = 0;

  try {
    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index];
      const fileName = uniqueDownloadName(item.name, reservedNames);
      const response = await fetch(`/images/${encodeURIComponent(item.id)}/download`, {
        credentials: 'same-origin',
        cache: 'no-store'
      });

      const contentType = response.headers.get('Content-Type') || '';
      if (response.redirected || contentType.includes('text/html')) {
        throw new Error('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi tiếp tục tải.');
      }
      if (!response.ok) {
        throw new Error(`Không thể tải ${item.name} (HTTP ${response.status}).`);
      }

      const responseSize = Number(
        response.headers.get('Content-Length') || item.size || 0
      );
      const baseBytes = completedBytes;

      const updateCurrentFile = (loaded) => {
        let percent;

        if (totalBytes > 0) {
          percent = (
            (baseBytes + Math.min(loaded, responseSize || loaded)) / totalBytes
          ) * 100;
        } else if (responseSize > 0) {
          percent = (
            (index + Math.min(loaded / responseSize, 1)) / selected.length
          ) * 100;
        } else {
          percent = (index / selected.length) * 100;
        }

        setDownloadProgress(
          percent,
          `Đang tải ${index + 1}/${selected.length}: ${fileName}`,
          `${formatBytes(baseBytes + loaded)} / ${
            totalBytes ? formatBytes(totalBytes) : 'không xác định'
          }`
        );
      };

      let actualBytes;

      if (directoryHandle) {
        actualBytes = await saveResponseToDirectory(
          response,
          directoryHandle,
          fileName,
          updateCurrentFile
        );
      } else {
        const blob = await responseToBlob(response, updateCurrentFile);
        actualBytes = blob.size;
        triggerBrowserDownload(blob, fileName);

        // Tránh gửi quá nhiều lệnh download cùng một lúc cho trình duyệt.
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }

      completed += 1;
      completedBytes += responseSize || actualBytes;

      const percent = totalBytes > 0
        ? (completedBytes / totalBytes) * 100
        : (completed / selected.length) * 100;

      setDownloadProgress(
        percent,
        `Đã tải ${completed}/${selected.length} ảnh`,
        `${formatBytes(completedBytes)}${
          totalBytes ? ` / ${formatBytes(totalBytes)}` : ''
        }`
      );
    }

    setDownloadProgress(
      100,
      `Hoàn tất ${completed}/${selected.length} ảnh.`,
      directoryHandle
        ? 'Các ảnh đã được lưu riêng lẻ vào thư mục bạn chọn.'
        : 'Các ảnh đã được gửi lần lượt tới trình duyệt.'
    );

    downloadProgressBox.classList.add('download-complete');
    showToast(`Đã tải ${completed} ảnh riêng lẻ.`, 'success');
  } catch (error) {
    downloadProgressBox.classList.add('upload-failed');
    downloadStatus.textContent = error.message || 'Không thể tải ảnh.';
    downloadDetail.textContent = `Đã hoàn thành ${completed}/${selected.length} ảnh.`;
    showToast(error.message || 'Không thể tải ảnh.', 'error');
  } finally {
    isBatchDownloading = false;
    if (selectAll) selectAll.disabled = false;
    checkboxes.forEach((checkbox) => { checkbox.disabled = false; });
    updateBatchButton();
  }
}

if (batchDownload) {
  batchDownload.addEventListener('click', downloadSelectedImages);
}
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
