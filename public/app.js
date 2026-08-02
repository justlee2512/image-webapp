const input = document.querySelector('#image-input');
const form = document.querySelector('.upload-form');
if (input && form) input.addEventListener('change', () => { if (input.files.length) form.submit(); });

const selectAll = document.querySelector('#select-all');
const checkboxes = [...document.querySelectorAll('.image-checkbox')];
const batchDownload = document.querySelector('#batch-download');
function updateBatchButton() {
  const selected = checkboxes.filter((checkbox) => checkbox.checked).length;
  if (batchDownload) {
    batchDownload.disabled = selected === 0;
    batchDownload.textContent = selected ? `↓ Tải ${selected} ảnh (.zip)` : '↓ Tải ảnh đã chọn (.zip)';
  }
  if (selectAll) selectAll.checked = checkboxes.length > 0 && selected === checkboxes.length;
}
if (selectAll) selectAll.addEventListener('change', () => { checkboxes.forEach((checkbox) => { checkbox.checked = selectAll.checked; }); updateBatchButton(); });
checkboxes.forEach((checkbox) => checkbox.addEventListener('change', updateBatchButton));
