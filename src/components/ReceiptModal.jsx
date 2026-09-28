import Modal from './Modal.jsx';
import { Receipt, PrintArea } from './Receipt.jsx';

export default function ReceiptModal({ receipt, onClose, title = 'Receipt', headline, actions }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          {actions}
          <button type="button" className="btn" onClick={() => window.print()}>
            🖨 Print / Save PDF
          </button>
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            Close
          </button>
        </>
      }
    >
      {headline}
      <div className="receipt-screen">
        <Receipt receipt={receipt} />
      </div>
      <PrintArea>
        <Receipt receipt={receipt} />
      </PrintArea>
    </Modal>
  );
}
