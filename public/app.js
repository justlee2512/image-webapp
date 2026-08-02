const input = document.querySelector('#image-input');
const form = document.querySelector('.upload-form');
if (input && form) input.addEventListener('change', () => { if (input.files.length) form.submit(); });

