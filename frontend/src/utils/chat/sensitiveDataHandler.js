import Swal from 'sweetalert2';

async function promptUserForSensitiveData(redactedMessage) {
  const { value: isConfirmed } = await Swal.fire({
    title: "Sensitive Data Detected",
    html: `Your message contains sensitive data:<br><br>${redactedMessage}`,
    showCancelButton: true,
    confirmButtonText: "Proceed",
    cancelButtonText: "Abort",
  });
  return { abort: !isConfirmed };
}

export { promptUserForSensitiveData };
