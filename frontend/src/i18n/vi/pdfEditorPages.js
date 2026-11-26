// Vietnamese dictionary: PDF editor (/pdf), pages: src/pages/pdfEditor/pages/** and viewer/**/*.jsx
// (page thumbnails, outline, page organiser: add, delete, duplicate, rotate, reorder, extract).
// Keys are the exact English texts used in the source (t("...") / tk("...")).
// Keep {placeholders} identical to the key. A key that another slice already has must carry the same text
// (labels of commands such as "Organise pages", "Blank page", "Rotate clockwise" live in pdfEditorTools.js).
//
// Wording follows the glossary of the UX specification: Trang trống (blank page), Khổ giấy (page size),
// Trích xuất (extract), Nhân bản (duplicate), Mục lục (outline), Hình thu nhỏ (thumbnail), Che dữ liệu
// (redact), Làm mờ (blur), Xóa, Hủy, tệp.
export default {
  // Pages panel and page tiles
  "Open a PDF file to see its pages here.": "Mở một tệp PDF để xem các trang tại đây.",
  "Page actions": "Thao tác với trang",
  "Add pages": "Thêm trang",
  "Rotated {degrees} degrees": "Đã xoay {degrees} độ",
  "1 redaction or blur mark waiting": "1 vùng che dữ liệu hoặc làm mờ đang chờ áp dụng",
  "{count} redaction or blur marks waiting": "{count} vùng che dữ liệu hoặc làm mờ đang chờ áp dụng",
  "From {name}": "Từ tệp {name}",

  // page menu
  "{count} pages selected": "Đã chọn {count} trang",
  "Insert blank page before": "Chèn trang trống phía trước",
  "Insert blank page after": "Chèn trang trống phía sau",
  "Move to position…": "Chuyển đến vị trí…",
  "Extract pages…": "Trích xuất trang…",
  "Delete {count} pages": "Xóa {count} trang",

  // organiser
  "Deselect all": "Bỏ chọn tất cả",
  "Selected pages": "Trang đã chọn",
  "Select one or more pages first.": "Hãy chọn một hoặc nhiều trang trước.",
  "All pages are selected: there is nowhere to move them.": "Đã chọn tất cả các trang nên không còn vị trí nào để chuyển.",
  "Delete the selected pages. Deleted pages are not in the downloaded file.": "Xóa các trang đã chọn. Trang đã xóa sẽ không có trong tệp tải xuống.",
  "Save the selected pages as a new PDF file": "Lưu các trang đã chọn thành một tệp PDF mới",
  "Thumbnail size": "Cỡ hình thu nhỏ",
  "Small thumbnails": "Hình thu nhỏ cỡ nhỏ",
  "Medium thumbnails": "Hình thu nhỏ cỡ vừa",
  "Large thumbnails": "Hình thu nhỏ cỡ lớn",
  "Back to the pages (Esc)": "Quay lại các trang (Esc)",
  "Drag pages to reorder them, or select pages and use the buttons above. Double-click a page to open it.": "Kéo trang để sắp xếp lại, hoặc chọn trang rồi dùng các nút phía trên. Bấm đúp vào một trang để mở trang đó.",
  "Pages of the document": "Các trang của tài liệu",

  // what a page operation says (announcements and toasts)
  "Page {page} rotated to the right": "Đã xoay phải trang {page}",
  "Page {page} rotated to the left": "Đã xoay trái trang {page}",
  "{count} pages rotated to the right": "Đã xoay phải {count} trang",
  "{count} pages rotated to the left": "Đã xoay trái {count} trang",
  "Page {page} duplicated": "Đã nhân bản trang {page}",
  "{count} pages duplicated": "Đã nhân bản {count} trang",
  "1 page deleted": "Đã xóa 1 trang",
  "{count} pages deleted": "Đã xóa {count} trang",
  "Other changes were made since. Use Undo (Ctrl+Z) to go back step by step.": "Đã có thay đổi khác sau thao tác này. Hãy dùng Hoàn tác (Ctrl+Z) để lùi lại từng bước.",
  "Page {page} moved to position {position}": "Đã chuyển trang {page} đến vị trí {position}",
  "{count} pages moved to position {position}": "Đã chuyển {count} trang đến vị trí {position}",
  "Already at the beginning": "Đã ở đầu tài liệu",
  "Already at the end": "Đã ở cuối tài liệu",
  "Blank page inserted as page {page}": "Đã chèn trang trống ở vị trí trang {page}",
  "{count} blank pages inserted from page {page}": "Đã chèn {count} trang trống, bắt đầu từ trang {page}",
  "1 page added from {name}": "Đã thêm 1 trang từ {name}",
  "{count} pages added from {name}": "Đã thêm {count} trang từ {name}",
  "1 image added as a page": "Đã thêm 1 ảnh thành trang",
  "{count} images added as pages": "Đã thêm {count} ảnh thành trang",

  // dialogs: where pages go
  "Before or after": "Trước hay sau",
  "Before page": "Trước trang",
  "After page": "Sau trang",
  "of {count}": "trên {count}",
  "Type a page number between 1 and {count}.": "Nhập số trang từ 1 đến {count}.",
  "Type a number between 1 and {max}.": "Nhập một số từ 1 đến {max}.",

  // dialog: blank page
  "Insert blank page": "Chèn trang trống",
  "Page size": "Khổ giấy",
  "Same as page {page}": "Giống trang {page}",
  "Same as the page next to it": "Giống trang bên cạnh",
  "Custom size": "Kích thước tùy chỉnh",
  "Width × height": "Rộng × cao",
  "Width in millimetres": "Chiều rộng (mm)",
  "Height in millimetres": "Chiều cao (mm)",
  "Type a size between {min} and {max} mm.": "Nhập kích thước từ {min} đến {max} mm.",
  "Orientation": "Hướng giấy",
  "Portrait": "Dọc",
  "Landscape": "Ngang",
  "How many": "Số lượng",

  // dialog: pages from a PDF
  "Insert pages from a PDF": "Chèn trang từ tệp PDF",
  "{name} (1 page)": "{name} (1 trang)",
  "{name} ({count} pages)": "{name} ({count} trang)",
  "1 page will be inserted.": "Sẽ chèn 1 trang.",
  "{count} pages will be inserted.": "Sẽ chèn {count} trang.",
  "Numbers and ranges, for example 1-3, 7. {all} takes every page.": "Nhập số trang và khoảng trang, ví dụ 1-3, 7. Nhập {all} để lấy mọi trang.",
  "Numbers and ranges, for example 1-3, 7.": "Nhập số trang và khoảng trang, ví dụ 1-3, 7.",
  "Type the pages to insert.": "Nhập các trang cần chèn.",
  "{token} is not a page number or a range.": "{token} không phải là số trang hay khoảng trang.",
  "{token} is not a page of this file: it has 1 page.": "{token} không phải là trang của tệp này: tệp chỉ có 1 trang.",
  "{token} is not a page of this file: it has {count} pages.": "{token} không phải là trang của tệp này: tệp có {count} trang.",

  // dialog: image as page
  "1 image becomes 1 page.": "1 ảnh sẽ thành 1 trang.",
  "{count} images become {count} pages, in this order.": "{count} ảnh sẽ thành {count} trang, theo thứ tự này.",
  "and {count} more": "và {count} tệp khác",
  "A4, image fitted": "A4, ảnh vừa khít trang",
  "Same as the image": "Bằng kích thước ảnh",
  "The image is made as large as an A4 page allows; a wide image gets a page that lies on its side.": "Ảnh được phóng lớn hết mức trong khổ A4; ảnh nằm ngang sẽ được đặt trên trang ngang.",
  "The page is exactly as large as the image (96 pixels per inch).": "Trang có kích thước đúng bằng ảnh (96 điểm ảnh mỗi inch).",
  "Reading the images…": "Đang đọc ảnh…",
  "This image type is not supported. Use PNG, JPEG, WebP, GIF, BMP or SVG.": "Định dạng ảnh này chưa được hỗ trợ. Hãy dùng PNG, JPEG, WebP, GIF, BMP hoặc SVG.",
  "{name} could not be read as an image. Use PNG, JPEG, WebP, GIF, BMP or SVG.": "Không đọc được {name} dưới dạng ảnh. Hãy dùng PNG, JPEG, WebP, GIF, BMP hoặc SVG.",

  // dialog: extract
  "Extract pages": "Trích xuất trang",
  "The pages are saved as a new PDF file. This document stays open.": "Các trang được lưu thành một tệp PDF mới. Tài liệu đang mở vẫn được giữ nguyên.",
  "1 page, saved as {name}": "1 trang, lưu thành {name}",
  "{count} pages, saved as {name}": "{count} trang, lưu thành {name}",
  "Type the pages to extract.": "Nhập các trang cần trích xuất.",
  "{token} is not a page of this document: it has 1 page.": "{token} không phải là trang của tài liệu này: tài liệu chỉ có 1 trang.",
  "{token} is not a page of this document: it has {count} pages.": "{token} không phải là trang của tài liệu này: tài liệu có {count} trang.",
  "Also remove these pages from this document": "Đồng thời xóa các trang này khỏi tài liệu đang mở",
  "A document needs at least one page, so all pages cannot be removed.": "Tài liệu cần ít nhất một trang nên không thể xóa tất cả các trang.",
  "Select the pages to extract first.": "Hãy chọn các trang cần trích xuất trước.",

  // dialog: move to position
  "Move to position": "Chuyển đến vị trí",
  "Move": "Chuyển",
  "New position": "Vị trí mới",
  "Page {page} becomes the page with this number.": "Trang {page} sẽ được chuyển đến vị trí có số này.",
  "The {count} selected pages are placed together, starting at this page number.": "{count} trang đã chọn sẽ được đặt liền nhau, bắt đầu từ vị trí có số này.",

  // Outline panel
  "This document has no outline.": "Tài liệu này không có mục lục.",
  "{title}, page {page}": "{title}, trang {page}"
};
