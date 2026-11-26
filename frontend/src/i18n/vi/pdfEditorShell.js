// Vietnamese dictionary: PDF editor (/pdf), the frame of the editor: src/pages/pdfEditor/PdfEditorPage.jsx
// and ui/** (app bar, tool bar, status bar, search, panels, notices, dialogs for open / password / leave, the
// questions and reports of Download / Print / the document that gets signed, signed and restricted documents,
// document properties, keyboard shortcuts) plus the placeholder a feature slot shows while it has nothing.
// Keys are the exact English texts used in the source (t("...") / tk("...")).
// Keep {placeholders} identical to the key. A key that another slice already has is NOT repeated here
// (labels of tools and commands: pdfEditorTools.js; sentences for engine codes: pdfEditorMessages.js).
export default {
  "PDF editor": "Trình chỉnh sửa PDF",
  "Back to home": "Về trang chủ",

  // empty state, opening and dropping files
  "Choose files": "Chọn tệp",
  "Choose another file": "Chọn tệp khác",
  "Blank document (A4)": "Tài liệu trống (A4)",
  "Drop PDF files here or choose files.": "Thả tệp PDF vào đây hoặc chọn tệp.",
  "Files are processed in your browser and are never uploaded.": "Tệp được xử lý ngay trong trình duyệt và không được tải lên máy chủ.",
  "Several files open as one document, in the order you choose them.": "Nhiều tệp sẽ được mở thành một tài liệu, theo thứ tự bạn chọn.",
  "Drop the files to open them": "Thả tệp để mở",
  "Add pages to this document": "Thêm trang vào tài liệu này",
  "Open instead of this document": "Mở thay cho tài liệu này",
  "Opening…": "Đang mở…",
  "Opened {count} files as one document ({pages} pages)": "Đã mở {count} tệp thành một tài liệu ({pages} trang)",
  "Files added: {count}. Pages added: {pages}.": "Số tệp đã thêm: {count}. Số trang đã thêm: {pages}.",
  "Only PDF files can be opened here.": "Chỉ có thể mở tệp PDF tại đây.",
  "{name}: {problem}": "{name}: {problem}",
  "{name} can be viewed but not edited here, so it cannot be combined with other files. Open it on its own to read it.":
    "{name} chỉ xem được, không chỉnh sửa được tại đây nên không thể ghép với tệp khác. Hãy mở riêng tệp này để đọc.",
  "Large file": "Tệp lớn",
  "This file is large ({size}). Opening it may be slow and use a lot of memory.": "Tệp này lớn ({size}). Việc mở tệp có thể chậm và tốn nhiều bộ nhớ.",
  "This file is large ({size}, {pages} pages). Editing may be slow and use a lot of memory.": "Tệp này lớn ({size}, {pages} trang). Thao tác có thể chậm và tốn nhiều bộ nhớ.",
  "Open anyway": "Vẫn mở",
  "Open another document?": "Mở tài liệu khác?",
  "Close this document?": "Đóng tài liệu này?",
  "Changes that were not downloaded will be lost.": "Các thay đổi chưa tải xuống sẽ bị mất.",
  "This page could not be displayed.": "Không hiển thị được trang này.",

  // app bar
  "The name of the downloaded file": "Tên của tệp tải xuống",
  "Untitled": "Chưa đặt tên",
  "Edited": "Đã chỉnh sửa",
  "Downloaded": "Đã tải xuống",
  "Signed": "Đã ký",
  "View only": "Chỉ xem",
  "There are changes that were not downloaded.": "Có thay đổi chưa tải xuống.",
  "Edits will invalidate {count} signatures": "Chỉnh sửa sẽ làm {count} chữ ký mất hiệu lực",
  "Edits will invalidate 1 signature": "Chỉnh sửa sẽ làm 1 chữ ký mất hiệu lực",
  "This file can be viewed but not edited here.": "Tệp này chỉ xem được, không chỉnh sửa được tại đây.",

  // tool bar
  "Editing tools": "Công cụ chỉnh sửa",
  "Undo and redo": "Hoàn tác và làm lại",
  "Open a PDF to use the tools.": "Hãy mở một tệp PDF để dùng các công cụ.",

  // search
  "Search in document": "Tìm trong tài liệu",
  "Searches the text of the original pages. Text you added is not searched.": "Tìm trong văn bản của các trang gốc. Văn bản bạn thêm vào chưa được tìm.",
  "No results": "Không có kết quả",
  "Search options": "Tùy chọn tìm kiếm",
  "Match case": "Phân biệt hoa thường",
  "Whole words": "Toàn bộ từ",
  "Match diacritics": "Phân biệt dấu",
  "Close search": "Đóng tìm kiếm",

  // panels
  "Side panels": "Bảng bên",
  "Close panel": "Đóng bảng",
  "Properties": "Thuộc tính",
  "Keep the panel open": "Giữ bảng luôn mở",
  "Unpin the panel": "Bỏ ghim bảng",
  "This part of the editor is not available yet.": "Phần này của trình chỉnh sửa chưa sẵn sàng.",
  "This part of the editor could not be displayed. Your document is not affected.": "Không hiển thị được phần này của trình chỉnh sửa. Tài liệu của bạn không bị ảnh hưởng.",
  "A part of the editor could not be displayed. Your document is not affected.": "Không hiển thị được một phần của trình chỉnh sửa. Tài liệu của bạn không bị ảnh hưởng.",

  // document summary
  "Size of this page": "Kích thước trang này",
  "{width} × {height} mm": "{width} × {height} mm",
  "Objects you added": "Đối tượng bạn đã thêm",
  "Pending redaction and blur marks": "Vùng che và làm mờ đang chờ áp dụng",
  "Digital signatures": "Chữ ký số",
  "Size of the source files": "Dung lượng các tệp nguồn",
  "Source files": "Tệp nguồn",
  "{count} pages": "{count} trang",
  "1 page": "1 trang",
  "Choose a tool to add something to a page, or select an object to change it.": "Chọn một công cụ để thêm nội dung vào trang, hoặc chọn một đối tượng để chỉnh sửa.",

  // page area and status bar
  "Document pages": "Các trang của tài liệu",
  "Page navigation": "Chuyển trang",
  "Page number": "Số trang",
  "Number of pages: {count}": "Số trang: {count}",
  "Zoom": "Thu phóng",
  "Zoom: {percent}%": "Thu phóng: {percent}%",
  "{count} marks pending": "{count} vùng đang chờ áp dụng",
  "1 mark pending": "1 vùng đang chờ áp dụng",
  "Marked areas are removed for real when you download.": "Nội dung trong các vùng đã đánh dấu sẽ bị xóa thật sự khi bạn tải xuống.",

  // download and print
  "Preparing document for printing…": "Đang chuẩn bị tài liệu để in…",
  "The file could not be created": "Không tạo được tệp",
  "Your work is still open.": "Nội dung đang làm vẫn được giữ.",
  "{name} was downloaded.": "Đã tải xuống {name}.",
  "Printing is not available in this browser": "Trình duyệt này không hỗ trợ in",
  "This browser cannot print PDF files from this page. Download the file and print it from your PDF viewer.": "Trình duyệt này không in được tệp PDF từ trang này. Hãy tải tệp xuống và in từ trình xem PDF của bạn.",
  "The print dialog could not be opened": "Không mở được hộp thoại in",
  "Download the file and print it from your PDF viewer.": "Hãy tải tệp xuống và in từ trình xem PDF của bạn.",
  "Notes about the created file": "Lưu ý về tệp vừa tạo",
  "Download options…": "Tùy chọn tải xuống…",
  "More ways to download": "Các cách tải xuống khác",

  // before an output is built: pending marks, text as pictures, what the file leaves out (ui/outputReport.js, ExportDialog)
  "Apply redactions and download": "Áp dụng che dữ liệu và tải xuống",
  "Apply and download": "Áp dụng và tải xuống",
  "Download options": "Tùy chọn tải xuống",
  "Download as it is": "Tải xuống nguyên trạng",
  "Apply redactions and print": "Áp dụng che dữ liệu và in",
  "Apply and print": "Áp dụng và in",
  "Print options": "Tùy chọn in",
  "Print as it is": "In nguyên trạng",
  "Apply redactions and sign": "Áp dụng che dữ liệu và ký",
  "Apply and continue": "Áp dụng và tiếp tục",
  "Before the document is signed": "Trước khi ký tài liệu",
  "Continue": "Tiếp tục",
  "Continue as it is": "Tiếp tục với tệp nguyên trạng",
  "Apply redactions and extract": "Áp dụng che dữ liệu và trích xuất",
  "Apply and extract": "Áp dụng và trích xuất",
  "Extract options": "Tùy chọn trích xuất",
  "Use the file as it is": "Dùng tệp nguyên trạng",
  "Go back": "Quay lại",
  "Text that will be exported as pictures": "Văn bản sẽ được xuất thành hình ảnh",
  "Redaction permanently removes the marked content from the downloaded file. It cannot be recovered from that file. Your original file is not changed.":
    "Che dữ liệu sẽ xóa vĩnh viễn nội dung đã đánh dấu khỏi tệp tải xuống và không thể khôi phục từ tệp đó. Tệp gốc của bạn không bị thay đổi.",
  "Redaction permanently removes the marked content from the file that is created. It cannot be recovered from that file. Your original file is not changed.":
    "Che dữ liệu sẽ xóa vĩnh viễn nội dung đã đánh dấu khỏi tệp được tạo ra và không thể khôi phục từ tệp đó. Tệp gốc của bạn không bị thay đổi.",
  "A blurred area is replaced by a blurred picture of it: the content under it is removed as well.": "Vùng làm mờ được thay bằng một hình ảnh đã làm mờ của chính nó: nội dung bên dưới cũng bị xóa.",
  "In the editor the marks stay pending, so you can still correct them and create the file again.": "Trong trình chỉnh sửa, các vùng đã đánh dấu vẫn ở trạng thái chờ áp dụng nên bạn vẫn có thể chỉnh lại rồi tạo tệp lần nữa.",
  "Areas that will be redacted: {count}": "Số vùng sẽ bị che: {count}",
  "Areas that will be blurred: {count}": "Số vùng sẽ được làm mờ: {count}",
  "Pages with marked areas: {count}": "Số trang có vùng đã đánh dấu: {count}",
  "Text lines you replaced: {count}": "Số dòng văn bản bạn đã thay: {count}",
  "1 text box contains characters that none of the editor's fonts can write ({characters}). It will be put into the file as a picture: its text cannot be selected or searched there.":
    "1 hộp văn bản có ký tự mà không phông chữ nào của trình chỉnh sửa viết được ({characters}). Hộp này sẽ được đưa vào tệp dưới dạng hình ảnh: không thể chọn hoặc tìm kiếm văn bản của nó trong tệp.",
  "{count} text boxes contain characters that none of the editor's fonts can write ({characters}). They will be put into the file as pictures: their text cannot be selected or searched there.":
    "{count} hộp văn bản có ký tự mà không phông chữ nào của trình chỉnh sửa viết được ({characters}). Các hộp này sẽ được đưa vào tệp dưới dạng hình ảnh: không thể chọn hoặc tìm kiếm văn bản của chúng trong tệp.",
  "The existing signature is not kept in the edited copy.": "Chữ ký số hiện có không được giữ lại trong bản đã chỉnh sửa.",
  "The {count} existing signatures are not kept in the edited copy.": "{count} chữ ký số hiện có không được giữ lại trong bản đã chỉnh sửa.",
  "The copy that is created is not protected: the restrictions and the password protection of the original are not in it.": "Bản được tạo ra không được bảo vệ: các giới hạn và mật khẩu bảo vệ của tệp gốc không còn trong bản này.",
  "Remove hidden information": "Xóa thông tin ẩn",
  "Document properties (title, author, subject, keywords)": "Thuộc tính tài liệu (tiêu đề, tác giả, chủ đề, từ khóa)",
  "Bookmarks (the outline of the document)": "Dấu trang (mục lục của tài liệu)",
  "(this document has none)": "(tài liệu này không có)",
  "Attached files are never copied into the file that is created.": "Tệp đính kèm không bao giờ được sao chép vào tệp được tạo ra.",
  "Download as": "Tải xuống với tên",

  // the built file still holds something the user removed (ExportReviewDialog)
  "Removed content is still in the file": "Nội dung đã xóa vẫn còn trong tệp",
  "The file was created, but it has not been handed out yet. Something you removed can still be found in it:": "Tệp đã được tạo nhưng chưa được giao cho bạn. Trong tệp vẫn còn tìm thấy nội dung bạn đã xóa:",
  "1 text line you replaced could only be covered (page {pages}): the old text is hidden under the new text, but it is still in the file.":
    "1 dòng văn bản bạn đã thay chỉ có thể được che phủ (trang {pages}): văn bản cũ bị ẩn dưới văn bản mới nhưng vẫn còn trong tệp.",
  "{count} text lines you replaced could only be covered (pages {pages}): the old text is hidden under the new text, but it is still in the file.":
    "{count} dòng văn bản bạn đã thay chỉ có thể được che phủ (các trang {pages}): văn bản cũ bị ẩn dưới văn bản mới nhưng vẫn còn trong tệp.",
  "Remove the old text for real (these pages may be converted to images)": "Xóa hẳn văn bản cũ (các trang này có thể bị chuyển thành ảnh)",
  "Convert these pages to images: {pages}": "Chuyển các trang này thành ảnh: {pages}",
  "Text you redacted also appears in the bookmarks of the document (places: {count}).": "Văn bản bạn đã che còn xuất hiện trong dấu trang của tài liệu (số vị trí: {count}).",
  "1 bookmark of a page you removed is still in the file, because bookmarks of the remaining pages are grouped under it. Its title can still be read there.":
    "1 dấu trang của trang bạn đã xóa vẫn còn trong tệp, vì các dấu trang của những trang còn lại được nhóm bên dưới nó. Tiêu đề của dấu trang đó vẫn đọc được trong tệp.",
  "{count} bookmarks of pages you removed are still in the file, because bookmarks of the remaining pages are grouped under them. Their titles can still be read there.":
    "{count} dấu trang của các trang bạn đã xóa vẫn còn trong tệp, vì các dấu trang của những trang còn lại được nhóm bên dưới chúng. Tiêu đề của các dấu trang đó vẫn đọc được trong tệp.",
  "Remove these bookmarks (the bookmarks under them move up one level)": "Xóa các dấu trang này (các dấu trang bên dưới được đưa lên một cấp)",
  "Leave the bookmarks out of the file": "Không đưa dấu trang vào tệp",
  "Text you redacted also appears in the document properties, such as the title or the author (places: {count}).": "Văn bản bạn đã che còn xuất hiện trong thuộc tính tài liệu, chẳng hạn tiêu đề hoặc tác giả (số vị trí: {count}).",
  "Leave the document properties out of the file": "Không đưa thuộc tính tài liệu vào tệp",
  "Choose what the editor should do about it. The file is then created again.": "Hãy chọn cách trình chỉnh sửa xử lý. Sau đó tệp sẽ được tạo lại.",
  "The editor cannot remove this for you. Cancel to change the document first, or continue if this is acceptable.": "Trình chỉnh sửa không thể xóa phần này giúp bạn. Hãy hủy để sửa tài liệu trước, hoặc tiếp tục nếu bạn chấp nhận.",
  "Apply and create the file again": "Áp dụng và tạo lại tệp",

  // the result report (ReportDialog)
  "Result of the redaction": "Kết quả che dữ liệu",
  "Redaction finished. {name} was downloaded.": "Đã che dữ liệu xong. Đã tải xuống {name}.",
  "Redaction finished. The document was sent to the print dialog.": "Đã che dữ liệu xong. Tài liệu đã được gửi tới hộp thoại in.",
  "The document was sent to the print dialog.": "Tài liệu đã được gửi tới hộp thoại in.",
  "Redaction finished. The file was created.": "Đã che dữ liệu xong. Tệp đã được tạo.",
  "The file was created.": "Tệp đã được tạo.",
  "1 area": "1 vùng",
  "{count} areas": "{count} vùng",
  "Removed precisely and verified.": "Đã xóa chính xác và đã kiểm chứng.",
  "Nothing had to be removed under the marks of this page.": "Dưới các vùng đã đánh dấu của trang này không có gì cần xóa.",
  "Converted to an image, because the content under the marks could not be removed precisely.": "Đã chuyển thành ảnh vì không thể xóa chính xác nội dung dưới các vùng đã đánh dấu.",
  "Converted to an image, as chosen.": "Đã chuyển thành ảnh theo lựa chọn của bạn.",
  "Links and form fields of this page are gone and its text is no longer sharp when enlarged; the text that remains can still be searched.":
    "Liên kết và trường biểu mẫu của trang này không còn, chữ không còn sắc nét khi phóng to; phần văn bản còn lại vẫn tìm kiếm được.",
  "The old text of the lines you replaced was removed.": "Văn bản cũ của các dòng bạn đã thay đã bị xóa.",
  "The lines you replaced were covered.": "Các dòng bạn đã thay đã được che phủ.",
  "1 replaced text line was only covered: its old text is still in the file.": "1 dòng văn bản đã thay chỉ được che phủ: văn bản cũ vẫn còn trong tệp.",
  "{count} replaced text lines were only covered: their old text is still in the file.": "{count} dòng văn bản đã thay chỉ được che phủ: văn bản cũ vẫn còn trong tệp.",
  "1 text box was put into the file as a picture: its text cannot be selected or searched there.": "1 hộp văn bản đã được đưa vào tệp dưới dạng hình ảnh: không thể chọn hoặc tìm kiếm văn bản của nó trong tệp.",
  "{count} text boxes were put into the file as pictures: their text cannot be selected or searched there.": "{count} hộp văn bản đã được đưa vào tệp dưới dạng hình ảnh: không thể chọn hoặc tìm kiếm văn bản của chúng trong tệp.",
  "Check the result before you share the file.": "Hãy kiểm tra kết quả trước khi chia sẻ tệp.",
  "Open the downloaded file in a new tab": "Mở tệp đã tải xuống trong thẻ mới",
  "Open the created file in a new tab": "Mở tệp vừa tạo trong thẻ mới",

  // a build that failed (ExportFailedDialog)
  "No file was created: nothing was downloaded.": "Không có tệp nào được tạo: không có gì được tải xuống.",
  "No file was created: nothing was printed.": "Không có tệp nào được tạo: không có gì được in.",
  "No file was created.": "Không có tệp nào được tạo.",
  "The editor checks every file before it hands it out. This file did not pass the check, so it was discarded.": "Trình chỉnh sửa kiểm tra mọi tệp trước khi giao cho bạn. Tệp này không qua được bước kiểm tra nên đã bị hủy bỏ.",
  "Try with the marked pages as images": "Thử lại với các trang đã đánh dấu chuyển thành ảnh",

  // signed and restricted documents
  "This document is signed": "Tài liệu này đã được ký",
  "Editing it will invalidate {count} existing signatures. The signed original file is not changed.": "Chỉnh sửa sẽ làm {count} chữ ký hiện có mất hiệu lực. Tệp gốc đã ký không bị thay đổi.",
  "Editing it will invalidate the existing signature. The signed original file is not changed.": "Chỉnh sửa sẽ làm chữ ký hiện có mất hiệu lực. Tệp gốc đã ký không bị thay đổi.",
  "Edit anyway": "Vẫn chỉnh sửa",
  "Changes restricted by the author": "Tác giả giới hạn chỉnh sửa",
  "Password-protected": "Có mật khẩu bảo vệ",
  "This file opens with a password. A copy you download after changing it is a new file that is not protected by a password. Downloaded without changes, it is the file itself.":
    "Tệp này được mở bằng mật khẩu. Bản bạn tải xuống sau khi chỉnh sửa là một tệp mới, không được bảo vệ bằng mật khẩu. Nếu tải xuống khi chưa chỉnh sửa, bạn nhận được chính tệp gốc.",
  "The author restricted changes to this file": "Tác giả đã giới hạn việc chỉnh sửa tệp này",
  "The author restricted changes to this file. You can read it; before the first edit you are asked whether you may change it.": "Tác giả đã giới hạn việc chỉnh sửa tệp này. Bạn có thể đọc tệp; trước lần chỉnh sửa đầu tiên, bạn sẽ được hỏi liệu bạn có được phép sửa hay không.",
  "The author restricted changes to this file. The copy you download is a new file that is not protected.": "Tác giả đã giới hạn việc chỉnh sửa tệp này. Bản bạn tải xuống là một tệp mới, không được bảo vệ.",
  "Edit it here only if you are allowed to change this document.": "Chỉ chỉnh sửa tại đây nếu bạn được phép thay đổi tài liệu này.",
  "The copy you download is a new file: it is not protected and does not carry the restrictions of the original. The original file is not changed.": "Bản bạn tải xuống là một tệp mới: không được bảo vệ và không mang các giới hạn của tệp gốc. Tệp gốc không bị thay đổi.",
  "I am allowed to edit this file": "Tôi được phép chỉnh sửa tệp này",

  // document properties
  "This document": "Tài liệu này",
  "Name of the download": "Tên tệp tải xuống",
  "Pages that come from no file": "Số trang không thuộc tệp nào",
  "File size": "Dung lượng tệp",
  "Author": "Tác giả",
  "Subject": "Chủ đề",
  "Keywords": "Từ khóa",
  "Created with": "Tạo bằng",
  "PDF producer": "Trình tạo PDF",
  "PDF version": "Phiên bản PDF",
  "Protected": "Được bảo vệ",
  "Yes: the author restricted changes": "Có: tác giả giới hạn chỉnh sửa",
  "Yes: a password is needed to open it": "Có: cần mật khẩu để mở",
  "Not set": "Chưa đặt",
  "The file you download carries the title, author, subject and keywords of the first file, unless you leave them out in the download options.":
    "Tệp bạn tải xuống mang tiêu đề, tác giả, chủ đề và từ khóa của tệp đầu tiên, trừ khi bạn bỏ các thông tin đó trong tùy chọn tải xuống.",

  // keyboard shortcuts
  "Search the shortcuts": "Tìm phím tắt",
  "Single-key shortcuts": "Phím tắt một phím",
  "Keys that work without Ctrl or Alt, such as V, T or 1. Switch them off if they get in your way, for example with a Vietnamese input method.":
    "Các phím hoạt động không cần Ctrl hoặc Alt, chẳng hạn V, T hoặc 1. Hãy tắt nếu chúng gây vướng, ví dụ khi dùng bộ gõ tiếng Việt.",
  "Keys": "Phím",
  "Active in": "Có hiệu lực tại",
  "or": "hoặc",
  "(hold)": "(giữ)",
  "Switched off": "Đã tắt",
  "Everywhere": "Mọi nơi",
  "No shortcut matches your search.": "Không có phím tắt nào khớp với nội dung tìm.",

  // leaving with work that was not downloaded
  "Leave the editor?": "Rời khỏi trình chỉnh sửa?",
  "You have changes that were not downloaded. Leave anyway?": "Bạn có thay đổi chưa tải xuống. Vẫn rời khỏi trang?",
  "Stay": "Ở lại",
  "Leave without downloading": "Rời đi, không tải xuống",
  "Download and leave": "Tải xuống rồi rời đi",

  // password prompt
  "Show password": "Hiện mật khẩu",
  "Hide password": "Ẩn mật khẩu",

  // notices about the page itself
  "Your session has ended. The document is still open here: download your work first, then sign in again.":
    "Phiên đăng nhập đã kết thúc. Tài liệu vẫn đang mở tại đây: hãy tải nội dung đang làm xuống trước, sau đó đăng nhập lại.",
  "This page is not opened over a secure connection (https), so signing with a certificate is not available. Everything else works.":
    "Trang này không được mở qua kết nối bảo mật (https) nên không dùng được tính năng ký số. Các tính năng khác vẫn hoạt động.",

  // what a screen reader hears when the view changes
  "Page {page} of {count}": "Trang {page} trên {count}",
  "Zoom {percent}%": "Thu phóng {percent}%",

  // a browser that cannot run the editor
  "This browser cannot run the PDF editor.": "Trình duyệt này không chạy được trình chỉnh sửa PDF.",
  "It is missing: {features}.": "Trình duyệt còn thiếu: {features}.",
  "Use a current version of Chrome, Edge, Firefox or Safari.": "Hãy dùng phiên bản mới của Chrome, Edge, Firefox hoặc Safari.",

  // the editor's own error screen
  "The editor ran into a problem.": "Trình chỉnh sửa gặp sự cố.",
  "Your document is still in memory. Try again to continue where you were.": "Tài liệu của bạn vẫn còn trong bộ nhớ. Hãy thử lại để tiếp tục công việc.",
  "Try again, or reload the page.": "Hãy thử lại hoặc tải lại trang."
};
